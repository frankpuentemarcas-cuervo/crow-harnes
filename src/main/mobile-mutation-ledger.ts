import { createHash } from 'node:crypto'

export interface MobileMutationContext { readonly id: string; readonly deviceId: string; readonly expiresAt: number }
export interface MobileMutationResult { status: number; body: unknown }
export type MobileMutationRoute = 'sessions' | 'wake' | 'close' | 'input' | 'resize'
export class MobileMutationRejectedError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
interface Entry { fingerprint: string; promise: Promise<MobileMutationResult>; bytes: number }
interface ContextLedger { context: MobileMutationContext; entries: Map<string, Entry> }
interface Options { now?: () => number; timeoutMs?: number; skewMs?: number; maxContexts?: number; maxEntries?: number; maxPerContext?: number; maxBytes?: number; maxInFlight?: number }
const RESULT_BYTES = 8192
const uncertain = (): MobileMutationResult => ({ status: 502, body: { error: 'Resultado incierto. Esta operación no se repite. Revisá la sesión antes de decidir otra acción.' } })

function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw new MobileMutationRejectedError(400, 'Solicitud demasiado compleja.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
  throw new MobileMutationRejectedError(400, 'Solicitud inválida.')
}

/** Volatile contextual at-most-once ledger, not an unlimited exactly-once guarantee.
 * Keep tombstones through bearer expiry + skew. Never evict accepted entries for capacity.
 * Transport MUST authenticate the context before each invocation, including replays.
 */
export class MobileMutationLedger {
  private contexts = new Map<string, ContextLedger>()
  private bytes = 0
  private inFlight = 0
  private options: Required<Options>
  constructor(options: Options = {}) {
    this.options = { now: Date.now, timeoutMs: 30_000, skewMs: 60_000, maxContexts: 64, maxEntries: 8192, maxPerContext: 2048, maxBytes: 8 * 1024 * 1024, maxInFlight: 32, ...options }
  }
  private prune(): void {
    for (const [id, ledger] of this.contexts) if (ledger.context.expiresAt + this.options.skewMs <= this.options.now()) {
      for (const entry of ledger.entries.values()) this.bytes -= entry.bytes
      this.contexts.delete(id)
    }
  }
  clear(): void { this.contexts.clear(); this.bytes = 0 } // Caller must retire transport contexts before clearing.
  async run(context: MobileMutationContext, requestId: unknown, route: MobileMutationRoute, body: unknown, action: () => Promise<MobileMutationResult>): Promise<MobileMutationResult> {
    this.prune()
    if (!context.id || !context.deviceId || !Number.isFinite(context.expiresAt) || context.expiresAt <= this.options.now()) throw new MobileMutationRejectedError(401, 'El contexto de autorización venció. Renovalo antes de otra acción.')
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw new MobileMutationRejectedError(400, 'requestId UUID requerido para esta operación.')
    const payload = canonical({ route, body })
    if (Buffer.byteLength(payload) > 16 * 1024) throw new MobileMutationRejectedError(400, 'Solicitud demasiado grande.')
    const fingerprint = createHash('sha256').update(payload).digest('hex')
    let ledger = this.contexts.get(context.id)
    if (ledger && (ledger.context.deviceId !== context.deviceId || ledger.context.expiresAt !== context.expiresAt)) throw new MobileMutationRejectedError(401, 'Contexto de autorización inválido.')
    const previous = ledger?.entries.get(requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new MobileMutationRejectedError(409, 'requestId ya usado con otro contenido. No se ejecutó la operación.')
      return structuredClone(await previous.promise)
    }
    const count = [...this.contexts.values()].reduce((sum, value) => sum + value.entries.size, 0)
    if ((!ledger && this.contexts.size >= this.options.maxContexts) || count >= this.options.maxEntries || (ledger?.entries.size || 0) >= this.options.maxPerContext || this.bytes + RESULT_BYTES > this.options.maxBytes || this.inFlight >= this.options.maxInFlight) throw new MobileMutationRejectedError(429, 'Límite de operaciones seguras. No se ejecutó la acción; esperá antes de una acción nueva.')
    if (!ledger) { ledger = { context, entries: new Map() }; this.contexts.set(context.id, ledger) }
    const entry: Entry = { fingerprint, promise: undefined!, bytes: RESULT_BYTES }
    ledger.entries.set(requestId, entry) // Reserve synchronously before starting or awaiting execution.
    this.bytes += RESULT_BYTES; this.inFlight++
    let timer: ReturnType<typeof setTimeout> | undefined
    const work = Promise.resolve().then(action).catch(() => uncertain()).finally(() => { this.inFlight-- })
    const deadline = new Promise<MobileMutationResult>(resolve => { timer = setTimeout(() => resolve(uncertain()), this.options.timeoutMs) })
    entry.promise = Promise.race([work, deadline]).then(value => {
      let result = value, bytes: number
      try {
        bytes = Buffer.byteLength(JSON.stringify(result))
        if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || bytes > RESULT_BYTES) throw new Error('Invalid result')
      } catch { result = uncertain(); bytes = Buffer.byteLength(JSON.stringify(result)) }
      if (this.contexts.get(context.id)?.entries.get(requestId) === entry) { this.bytes += bytes - entry.bytes; entry.bytes = bytes }
      return structuredClone(result)
    }).finally(() => { if (timer) clearTimeout(timer) })
    return structuredClone(await entry.promise)
  }
}
