import type { ConnectionStatus, SessionInfo } from './types'

export type CacheState = 'unknown' | 'unobserved' | 'warm' | 'cold'
export interface CacheWarningPreferences { enabled: boolean; warnSeconds: number }

export function cacheWarningPreferences(value: unknown): CacheWarningPreferences {
  const data = value && typeof value === 'object' ? value as Partial<CacheWarningPreferences> : {}
  return { enabled: typeof data.enabled === 'boolean' ? data.enabled : true,
    warnSeconds: typeof data.warnSeconds === 'number' && Number.isInteger(data.warnSeconds) && data.warnSeconds >= 15 && data.warnSeconds <= 300 ? data.warnSeconds : 60 }
}

export function cacheView(session: SessionInfo, status: ConnectionStatus, now: number): { state: CacheState; remainingSeconds: number } {
  const cache = session.promptCache
  const unknown = { state: 'unknown' as const, remainingSeconds: 0 }
  if (status !== 'connected' || !session.hooksActive || !['running', 'sleeping'].includes(session.state) || cache?.source !== 'claude-statusline') return unknown
  if (cache.observed === false) return { state: 'unobserved', remainingSeconds: 0 }
  if (cache.warm === false) return { state: 'cold', remainingSeconds: 0 }
  if (cache.warm !== true || ![300, 3600].includes(cache.ttlSeconds || 0)) return unknown
  const expiry = Date.parse(cache.expiresAt || '')
  if (!Number.isFinite(expiry)) return unknown
  const serverTime = Date.parse(cache.serverTime || '')
  // Anchor to request start conservatively, so clock skew or network latency
  // cannot grant extra cache time. Canonical expiry remains the entry's identity.
  const clientExpiry = Number.isFinite(serverTime) && cache.receivedAt !== undefined ? cache.receivedAt + expiry - serverTime : expiry
  const remainingSeconds = Math.max(0, Math.ceil((clientExpiry - now) / 1000))
  return { state: remainingSeconds ? 'warm' : 'cold', remainingSeconds }
}

export interface CacheWarningCandidate { key: string; session: SessionInfo; status: ConnectionStatus }

/** Bounded by live sessions, not countdown ticks. Independent from agent notices. */
export class CacheWarningTracker {
  private warned = new Map<string, string>()
  get size(): number { return this.warned.size }

  collect<T extends CacheWarningCandidate>(candidates: T[], now: number, preferences: CacheWarningPreferences): T[] {
    const keys = new Set(candidates.map(item => item.key))
    for (const key of this.warned.keys()) if (!keys.has(key)) this.warned.delete(key)
    if (!preferences.enabled) return []
    const result: T[] = []
    for (const item of candidates) {
      const view = cacheView(item.session, item.status, now)
      const cache = item.session.promptCache
      if (view.state !== 'warm' || view.remainingSeconds > preferences.warnSeconds || item.session.agentState === 'working' || !cache) continue
      const generation = `${cache.conversationId || ''}:${cache.expiresAt}`
      if (this.warned.get(item.key) === generation) continue
      this.warned.set(item.key, generation)
      result.push(item)
    }
    return result
  }
}
