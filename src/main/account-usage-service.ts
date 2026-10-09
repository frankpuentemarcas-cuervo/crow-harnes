import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountUsage, UsageWindow } from '../shared/account-usage'
import type { AccountUsageAdapter } from './account-usage-adapters'

const CACHE_MS = 180_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const messages = {
  'signed-out': 'Iniciá sesión nuevamente para consultar esta cuenta.',
  unsupported: 'La herramienta instalada no permite consultar esta cuenta. Revisá su versión y autenticación.',
  'rate-limited': 'El proveedor limitó las consultas. Esperá la próxima actualización.',
  error: 'No se pudo consultar el uso. Revisá conexión y disponibilidad del proveedor.'
}

// Whitelist every field crossing storage/IPC. Never persist CLI responses or credentials.
function windows(value: unknown): UsageWindow[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Cuotas inválidas.')
  return value.map(item => {
    if (!item || typeof item.id !== 'string' || item.id.length > 100 || typeof item.label !== 'string' || item.label.length > 100 || !Number.isFinite(item.usedPercent) || item.usedPercent < 0 || item.usedPercent > 100) throw new Error('Cuotas inválidas.')
    const result: UsageWindow = { id: item.id, label: item.label, usedPercent: item.usedPercent }
    if (Number.isFinite(item.resetsAt) && item.resetsAt > 0) result.resetsAt = item.resetsAt
    if (Number.isFinite(item.windowMinutes) && item.windowMinutes > 0) result.windowMinutes = item.windowMinutes
    return result
  })
}

export class AccountUsageService {
  private readonly directory: string
  private readonly file: string
  private readonly accounts = new Map<string, AccountUsage>()
  private readonly pending = new Map<string, Promise<AccountUsage>>()
  private readonly nextQuery = new Map<string, number>()
  private readonly waiters: (() => void)[] = []
  private active = 0
  private stopped = false
  private readonly adapters: Record<'claude' | 'codex', AccountUsageAdapter>
  private readonly now: () => number

  constructor(directory: string, adapters: Record<'claude' | 'codex', AccountUsageAdapter>, now: () => number = Date.now) {
    this.adapters = adapters
    this.now = now
    this.directory = join(directory, 'account-profiles')
    this.file = join(directory, 'accounts.json')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      if (statSync(this.file).size > 512_000) return
      const rows: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(rows)) return
      for (const row of rows.slice(0, 30)) {
        if (!row || !UUID.test(row.id) || !['claude', 'codex'].includes(row.provider) || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 80) continue
        const account: AccountUsage = { id: row.id, provider: row.provider, label: row.label, status: 'signed-out', windows: [] }
        // Sample provenance survives restart, authentication does not get inferred from disk.
        if (Number.isFinite(row.updatedAt) && row.updatedAt > 0) {
          account.windows = windows(row.windows)
          account.updatedAt = row.updatedAt
          account.status = 'stale'
          if (typeof row.identity === 'string' && row.identity.length <= 200) account.identity = row.identity
        }
        if (Number.isFinite(row.retryAt) && row.retryAt > this.now() && row.retryAt <= this.now() + 7 * 86_400_000) {
          account.retryAt = row.retryAt
          account.status = 'rate-limited'
          account.error = messages['rate-limited']
          this.nextQuery.set(account.id, row.retryAt)
        }
        this.accounts.set(account.id, account)
      }
    } catch { /* Corrupt registry cannot grant profile paths or authentication. */ }
  }

  private persist(): void {
    try {
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, JSON.stringify(this.list()), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.file)
    } catch { throw new Error('No se pudo guardar el registro de cuentas. Revisá permisos y espacio disponible.') }
  }

  list(): AccountUsage[] {
    return [...this.accounts.values()].map(account => this.dto(account))
  }

  private dto(account: AccountUsage): AccountUsage {
    const result = structuredClone(account)
    if (result.status === 'ready' && result.updatedAt !== undefined && this.now() - result.updatedAt >= CACHE_MS) result.status = 'stale'
    return result
  }

  add(input: unknown): AccountUsage {
    if (this.stopped) throw new Error('Servicio de cuentas detenido.')
    if (!input || typeof input !== 'object') throw new Error('Cuenta inválida.')
    const { provider, label } = input as { provider?: unknown; label?: unknown }
    if ((provider !== 'claude' && provider !== 'codex') || typeof label !== 'string' || !label.trim() || label.trim().length > 80 || /[\x00-\x1f]/.test(label)) throw new Error('Proveedor o nombre de cuenta inválido.')
    if (this.accounts.size >= 30) throw new Error('Máximo 30 cuentas registradas.')
    const account: AccountUsage = { id: randomUUID(), provider, label: label.trim(), status: 'signed-out', windows: [] }
    this.accounts.set(account.id, account)
    const profile = this.profilePath(account.id)
    try {
      mkdirSync(profile, { recursive: true, mode: 0o700 })
      this.persist()
    } catch {
      this.accounts.delete(account.id)
      void rm(profile, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('No se pudo agregar la cuenta. Revisá permisos y espacio disponible.')
    }
    return this.dto(account)
  }

  profilePath(id: string): string {
    if (typeof id !== 'string' || !UUID.test(id) || !this.accounts.has(id)) throw new Error('Cuenta desconocida.')
    return join(this.directory, id)
  }

  async remove(id: string): Promise<void> {
    const profile = this.profilePath(id)
    const pending = this.pending.get(id)
    const account = this.accounts.get(id)!
    this.accounts.delete(id)
    try { this.persist() } catch (error) { this.accounts.set(id, account); throw error }
    this.nextQuery.delete(id)
    // Registry removal is immediate. Never race credential deletion with an active CLI.
    const cleanup = () => rm(profile, { recursive: true, force: true }).catch(() => undefined)
    if (pending) void pending.finally(cleanup).catch(() => undefined)
    else await cleanup()
  }

  login(id: string): Promise<AccountUsage> { return this.run(id, true) }
  refresh(id: string): Promise<AccountUsage> { return this.run(id, false) }

  private async slot(): Promise<void> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiters.push(resolve))
    this.active++
  }

  private run(id: string, login: boolean): Promise<AccountUsage> {
    const profile = this.profilePath(id)
    if (this.stopped) return Promise.reject(new Error('Servicio de cuentas detenido.'))
    const existing = this.pending.get(id)
    if (existing) return existing
    const account = this.accounts.get(id)!
    if (!login && (this.nextQuery.get(id) || 0) > this.now()) return Promise.resolve(this.dto(account))
    if (login) {
      const previous = structuredClone(account)
      account.status = 'signing-in'; account.windows = []
      delete account.updatedAt; delete account.identity; delete account.error; delete account.retryAt
      try { this.persist() } catch (error) { this.accounts.set(id, previous); throw error }
    }
    const operation = (async () => {
      await this.slot()
      try {
        if (this.stopped || !this.accounts.has(id)) return this.dto(account)
        const adapter = this.adapters[account.provider]
        if (login) await adapter.login(profile)
        // A removal while login was open must not trigger a quota request.
        if (this.stopped || !this.accounts.has(id)) return this.dto(account)
        const sample = await adapter.usage(profile)
        const normalized = windows(sample.windows)
        if (this.stopped || !this.accounts.has(id)) return this.dto(account)
        account.windows = normalized
        account.status = normalized.length ? 'ready' : 'unsupported'
        account.updatedAt = this.now()
        delete account.error; delete account.retryAt; delete account.identity
        if (typeof sample.identity === 'string' && sample.identity.length <= 200) account.identity = sample.identity
        this.nextQuery.set(id, this.now() + CACHE_MS)
      } catch (error) {
        if (this.stopped || !this.accounts.has(id)) return this.dto(account)
        const failure = error as { code?: string; retryAt?: number }
        const code = failure?.code && Object.hasOwn(messages, failure.code) ? failure.code as keyof typeof messages : 'error'
        account.error = messages[code]
        account.status = code === 'error' && account.updatedAt !== undefined ? 'stale' : code
        if (code === 'signed-out' || code === 'unsupported') { account.windows = []; delete account.updatedAt; delete account.identity }
        account.retryAt = code === 'rate-limited' ? Math.min(this.now() + 7 * 86_400_000, Math.max(this.now() + 30_000, Number.isFinite(failure.retryAt) ? failure.retryAt! : this.now() + CACHE_MS)) : undefined
        this.nextQuery.set(id, account.retryAt || this.now() + 30_000)
      } finally {
        this.active--; this.waiters.shift()?.()
      }
      if (!this.stopped && this.accounts.has(id)) this.persist()
      return this.dto(account)
    })()
    this.pending.set(id, operation)
    void operation.finally(() => this.pending.delete(id)).catch(() => undefined)
    return operation
  }

  stop(): void {
    this.stopped = true
    for (const adapter of Object.values(this.adapters)) adapter.dispose?.()
    for (const wake of this.waiters.splice(0)) wake()
  }
}
