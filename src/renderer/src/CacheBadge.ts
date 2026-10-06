import { createElement } from 'react'
import type { ConnectionStatus, SessionInfo } from '../../shared/types'
import { cacheView } from '../../shared/prompt-cache.ts'

const counts = (n: number | undefined): string => n === undefined ? '—' : n.toLocaleString('en-US')
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
export const cacheCauseLabels: Record<string, string> = {
  model_changed: 'Cambió el modelo', effort_changed: 'Cambió el esfuerzo', thinking_changed: 'Cambió el razonamiento',
  tools_changed: 'Cambiaron las herramientas', system_prompt_changed: 'Cambió el prompt del sistema', messages_changed: 'Cambió el historial',
  ttl_expired_5m: 'Venció la ventana de 5 min', ttl_expired_1h: 'Venció la ventana de 1 h', likely_server_side: 'Posible causa del proveedor'
}

export function CacheBadge({ session, status, now, compact = false, onOpen }: { session: SessionInfo; status: ConnectionStatus; now: number; compact?: boolean; onOpen?: () => void }): React.JSX.Element | null {
  if (session.agent !== 'claude') return null
  const view = cacheView(session, status, now)
  const cache = session.promptCache
  const label = status !== 'connected' ? 'Sin conexión' : view.state === 'unknown' ? 'Sin datos' : view.state === 'unobserved' ? 'No detectada' : view.state === 'cold' ? 'Vencida / fría' : 'Activa'
  const ratio = cache?.hitRatio === undefined ? '—' : `${Math.round(cache.hitRatio * 100)}%`
  const ttl = cache?.ttlSeconds === 3600 ? '1 h' : cache?.ttlSeconds === 300 ? '5 min' : '—'
  const detail = `Caché Claude · ${label}. TTL: ${ttl}. Reutilización de la sesión principal: ${ratio}. Última solicitud: leídos ${counts(cache?.readTokens)}, escritos ${counts(cache?.writtenTokens)}, nuevos ${counts(cache?.freshTokens)} tokens. No incluye subagentes ni garantiza el próximo acierto.`
  const text = compact ? (view.state === 'warm' ? clock(view.remainingSeconds) : label) : `Caché · ${label}${view.state === 'warm' ? ` ${clock(view.remainingSeconds)} · ${ratio}` : ''}`
  return createElement(onOpen ? 'button' : 'span', {
    className: `cache-badge ${view.state} ${compact ? 'compact' : ''}`, title: detail,
    'aria-label': detail, 'aria-live': 'off', ...(onOpen ? { type: 'button', onClick: onOpen } : {})
  }, text)
}
