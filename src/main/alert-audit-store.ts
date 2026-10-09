import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretEncryption } from './alert-ai-settings'
import type { AlertAuditRecord, AlertAuditStatus, AlertAuditSummary, AttentionAudit, AuditRef, NoticeSoundOutcome } from '../shared/alert-diagnostics'

const TTL = 7 * 86400000
const FILE = /^\d{13}-[a-f0-9]{64}\.bin$/
const OUTCOMES = ['eligible', 'pending', 'informational', 'already-read', 'duplicate', 'restored', 'stale', 'scheduled', 'playback-ended', 'playback-error']

export class AlertAuditStore implements AttentionAudit {
  private readonly directory: string
  private readonly encryption: SecretEncryption
  private readonly now: () => number
  private readonly secrets: () => string[]
  private enabled = false
  private error?: string
  private generation = 0
  private active = new Map<string, AuditRef>()

  constructor(directory: string, encryption: SecretEncryption, now = Date.now, secrets: () => string[] = () => []) {
    this.directory = join(directory, 'alert-audit'); this.encryption = encryption; this.now = now; this.secrets = secrets
    try {
      const path = join(this.directory, 'settings.json')
      if (existsSync(path)) {
        const value = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof value.enabled !== 'boolean') throw new Error()
        this.enabled = value.enabled
      }
      this.prune()
    } catch { this.enabled = false; this.error = 'No se pudo cargar el diagnóstico local.' }
  }

  status(): AlertAuditStatus {
    this.prune()
    return { enabled: this.enabled && this.encryption.isEncryptionAvailable(), secureStorageAvailable: this.encryption.isEncryptionAvailable(), count: this.files().length, retentionDays: 7, error: this.error }
  }

  setEnabled(enabled: boolean): AlertAuditStatus {
    if (typeof enabled !== 'boolean') throw new Error('Configuración de diagnóstico inválida.')
    if (enabled && !this.encryption.isEncryptionAvailable()) throw new Error('El cifrado seguro de Windows no está disponible.')
    this.atomic('settings.json', Buffer.from(JSON.stringify({ enabled })))
    this.enabled = enabled; this.generation++; this.active.clear(); this.error = undefined
    return this.status()
  }

  begin(hostId: string, event: Parameters<AttentionAudit['begin']>[1], model: string): AuditRef | undefined {
    if (!this.enabled || !this.encryption.isEncryptionAvailable()) return
    try {
      this.prune()
      const key = JSON.stringify([hostId, event.id])
      const id = `${this.now()}-${createHash('sha256').update(key).digest('hex')}.bin`
      const ref = { id, generation: this.generation }
      const input = (event.message || '').slice(0, 24000)
      this.write({ id, hostId, eventId: event.id, sessionId: event.sessionId, eventAt: event.at, receivedAt: new Date(this.now()).toISOString(), input, inputChars: event.message?.length || 0, inputTruncated: !!event.messageTruncated || input.length < (event.message?.length || 0), requestedModel: model, promptVersion: 'attention-v2', sound: [] })
      this.active.set(key, ref)
      if (this.active.size > 500) this.active.delete(this.active.keys().next().value!)
      this.prune()
      return ref
    } catch { this.error = 'No se pudo guardar el diagnóstico cifrado.'; return }
  }

  update(ref: AuditRef | undefined, patch: Parameters<AttentionAudit['update']>[1]): void {
    if (!ref || ref.generation !== this.generation || !this.enabled) return
    const row = this.detail(ref.id)
    if (!row) return
    // No generic object spreads: credentials/headers are never an audit field.
    for (const field of ['classification', 'reasonCode', 'explanation', 'reportedModel', 'httpStatus', 'queueMs', 'inferenceMs', 'finishedAt', 'noticeEmitted'] as const) {
      if (patch[field] !== undefined) Object.assign(row, { [field]: patch[field] })
    }
    try { this.write(row) } catch { this.error = 'No se pudo actualizar el diagnóstico cifrado.' }
  }

  sound(hostId: string, eventId: string, outcome: NoticeSoundOutcome): void {
    if (!OUTCOMES.includes(outcome) || !this.enabled) return
    const ref = this.active.get(JSON.stringify([hostId, eventId]))
    if (!ref || ref.generation !== this.generation) return
    const row = this.detail(ref.id)
    if (!row || row.sound.at(-1)?.outcome === outcome) return
    row.sound.push({ at: new Date(this.now()).toISOString(), outcome }); row.sound = row.sound.slice(-12)
    try { this.write(row) } catch { this.error = 'No se pudo registrar el estado del sonido.' }
  }

  list(): AlertAuditSummary[] {
    this.prune()
    return this.files().slice(0, 100).flatMap(id => {
      const row = this.detail(id)
      if (!row) return []
      const { input: _input, explanation: _explanation, ...summary } = row
      return [summary]
    })
  }

  detail(id: string): AlertAuditRecord | undefined {
    if (typeof id !== 'string' || !FILE.test(id) || this.now() - Number(id.slice(0, 13)) >= TTL || !this.encryption.isEncryptionAvailable()) return
    try {
      const path = join(this.directory, id)
      if (!existsSync(path)) return
      if (statSync(path).size > 256 * 1024) throw new Error()
      const row = JSON.parse(this.encryption.decryptString(readFileSync(path)))
      if (row.id !== id || typeof row.input !== 'string' || row.input.length > 24000 || typeof row.hostId !== 'string' || !Array.isArray(row.sound)) throw new Error()
      return row
    } catch { this.error = 'Hay un registro dañado o no se pudo descifrar; no se borró.'; return }
  }

  exportJSON(): string {
    this.prune()
    return JSON.stringify({ format: 'crow-alert-audit-v1', exportedAt: new Date(this.now()).toISOString(), records: this.files().flatMap(id => { const row = this.detail(id); return row ? [row] : [] }) }, null, 2)
  }

  clear(): void {
    this.generation++; this.active.clear()
    for (const id of this.files()) rmSync(join(this.directory, id), { force: true })
    this.error = undefined
  }

  prune(): void {
    try {
      let count = 0, bytes = 0
      for (const id of this.files()) {
        const path = join(this.directory, id), size = statSync(path).size
        if (this.now() - Number(id.slice(0, 13)) >= TTL || ++count > 500 || (bytes += size) > 20 * 1024 * 1024) rmSync(path, { force: true })
      }
    } catch { this.error = 'No se pudo aplicar la retención del diagnóstico.' }
  }

  private files(): string[] {
    try { return readdirSync(this.directory).filter(id => FILE.test(id)).sort().reverse() } catch { return [] }
  }

  private write(row: AlertAuditRecord): void {
    const secrets = this.secrets()
    const redact = (text: string): string => secrets.reduce((value, secret) => secret ? value.replaceAll(secret, '[REDACTADO]') : value, text)
      .replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTADO]').replace(/(["']?(?:api[_ -]?key|password|contraseña|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTADO]')
    // Best-effort defense for secrets pasted into the assistant reply. No headers
    // or configured API keys are logged. Private business text remains private.
    const value = structuredClone(row)
    for (const field of ['input', 'explanation', 'reportedModel', 'requestedModel'] as const) if (value[field]) value[field] = redact(value[field]!)
    if (value.classification) value.classification.detail = redact(value.classification.detail)
    value.inputRedacted ||= value.input !== row.input
    value.inputTruncated ||= value.input.length > 24000
    value.input = value.input.slice(0, 24000)
    this.atomic(row.id, this.encryption.encryptString(JSON.stringify(value)))
  }

  private atomic(id: string, bytes: Buffer): void {
    mkdirSync(this.directory, { recursive: true })
    const path = join(this.directory, id), temp = `${path}.tmp`
    try { writeFileSync(temp, bytes, { mode: 0o600 }); renameSync(temp, path) } finally { rmSync(temp, { force: true }) }
  }
}
