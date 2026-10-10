import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { MobileActorBinding, MobileCapabilities, MobileDevice, MobileEnrollment } from '../shared/mobile-companion'

export const INVITATION_TTL = 5 * 60_000
export const DEVICE_TTL = 12 * 60 * 60_000
export const READ_CAPABILITIES: MobileCapabilities = { input: false, create: false, close: false, quotas: false }
export interface MobileScope { projectId: string; hostId: string; root: string; hostDigest: string; binding: MobileActorBinding }
export interface DeviceRecord { device: MobileDevice; scopes: MobileScope[]; tokenHash: string }
interface Invitation { value: MobileEnrollment; scopes: MobileScope[]; capabilities: MobileCapabilities; codeHash: string }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function matches(value: string, hash: string): boolean {
  const candidate = Buffer.from(digest(value), 'hex')
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}

/** Activation-local credentials. Only SHA256 hashes are retained, never plaintext bearer tokens. */
export class MobileDeviceRegistry {
  private pending?: Invitation
  private records = new Map<string, DeviceRecord>()
  private attempts = new Map<string, { count: number; until: number }>()
  private total = { count: 0, until: 0 }
  constructor(private now: () => number = Date.now) {}

  invite(value: Omit<MobileEnrollment, 'invitationCode' | 'expiresAt'>, scopes: MobileScope[], capabilities: MobileCapabilities): MobileEnrollment {
    for (const record of this.records.values()) if (!this.active(record)) this.records.delete(record.device.id)
    if (!scopes.length || this.records.size >= 16) throw new Error('Seleccioná proyectos autorizados (máximo 16 dispositivos).')
    const invitationCode = randomBytes(6).toString('hex').toUpperCase()
    const enrollment: MobileEnrollment = { ...value, invitationCode, expiresAt: new Date(this.now() + INVITATION_TTL).toISOString() }
    this.pending = { value: enrollment, scopes: structuredClone(scopes), capabilities: { ...capabilities }, codeHash: digest(invitationCode) }
    return enrollment
  }
  invitation(): MobileEnrollment | undefined {
    if (this.pending && Date.parse(this.pending.value.expiresAt) <= this.now()) this.pending = undefined
    return this.pending?.value
  }
  candidate(code: string, ip: string): MobileScope[] {
    const now = this.now()
    if (this.total.until <= now) this.total = { count: 0, until: now + 60_000 }
    const attempt = this.attempts.get(ip)
    if (++this.total.count > 60 || (attempt && attempt.until > now && attempt.count >= 5)) throw new Error('RATE_LIMIT')
    const pending = this.invitation() && this.pending
    if (!pending || !matches(code, pending.codeHash)) {
      if (this.attempts.size >= 256 && !this.attempts.has(ip)) this.attempts.delete(this.attempts.keys().next().value!)
      this.attempts.set(ip, { count: attempt && attempt.until > now ? attempt.count + 1 : 1, until: now + 10 * 60_000 })
      throw new Error('Código inválido o vencido.')
    }
    return structuredClone(pending.scopes)
  }
  pair(code: string, label: string): { record: DeviceRecord; credential: string } {
    const pending = this.invitation() && this.pending
    if (!pending || !matches(code, pending.codeHash)) throw new Error('Código inválido o vencido.')
    if (!label.trim() || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Nombre de dispositivo inválido.')
    this.pending = undefined // Consume synchronously only after all asynchronous actor checks.
    const credential = randomBytes(32).toString('hex')
    const device: MobileDevice = { id: randomUUID(), label: label.trim(), pairedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + DEVICE_TTL).toISOString(), projectIds: pending.scopes.map(scope => scope.projectId), capabilities: pending.capabilities }
    const record = { device, scopes: pending.scopes, tokenHash: digest(credential) }
    this.records.set(device.id, record)
    return { record, credential }
  }
  authenticate(credential: string): DeviceRecord | undefined {
    if (!/^[0-9a-f]{64}$/.test(credential)) return undefined
    for (const record of this.records.values()) {
      if (Date.parse(record.device.expiresAt) <= this.now()) { this.records.delete(record.device.id); continue }
      if (matches(credential, record.tokenHash)) return record
    }
    return undefined
  }
  active(record: DeviceRecord): boolean { return this.records.get(record.device.id) === record && Date.parse(record.device.expiresAt) > this.now() }
  list(): MobileDevice[] { return [...this.records.values()].filter(record => this.active(record)).map(record => structuredClone(record.device)) }
  revoke(id: string): void { this.records.delete(id) }
  invalidateHost(hostId: string): string[] {
    if (this.pending?.scopes.some(scope => scope.hostId === hostId)) this.pending = undefined
    const ids = [...this.records.values()].filter(record => record.scopes.some(scope => scope.hostId === hostId)).map(record => record.device.id)
    ids.forEach(id => this.revoke(id))
    return ids
  }
  clear(): void { this.pending = undefined; this.records.clear(); this.attempts.clear(); this.total = { count: 0, until: 0 } }
}
