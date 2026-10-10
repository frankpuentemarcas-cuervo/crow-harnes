export function parseEnrollment(raw, now = Date.now()) {
  const value = JSON.parse(raw)
  if (value?.version !== 1 || typeof value.gatewayId !== 'string' || !value.gatewayId || typeof value.invitationCode !== 'string' || !value.invitationCode || !Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 8 || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now) throw new Error('Invitación inválida o vencida. Generá otra desde Crow en Windows.')
  for (const endpoint of value.endpoints) {
    const url = new URL(endpoint.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/' || !['lan-pinned', 'remote-public'].includes(endpoint.kind)) throw new Error('El endpoint debe ser un origen HTTPS exacto.')
    if (endpoint.kind === 'lan-pinned' && !/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(endpoint.certSHA256 ?? '')) throw new Error('Falta la huella SHA-256 válida del certificado LAN.')
  }
  return value
}
export const MAX_INPUT_BYTES = 2048
export function inputByteLength(text) { return new TextEncoder().encode(text).length }
export function encodeInput(text) { const bytes = new TextEncoder().encode(text); if (bytes.length > MAX_INPUT_BYTES) throw new Error('El envío supera 2048 bytes UTF-8. Acortá el texto: no se divide ni se envía automáticamente.'); return btoa(String.fromCharCode(...bytes)) }
export function decodeOutput(text) { return Uint8Array.from(atob(text), character => character.charCodeAt(0)) }
export class OutputCursor {
  seq = 0
  accept(frame) {
    if (frame.type !== 'output' || typeof frame.data !== 'string' || !Number.isSafeInteger(frame.seq) || frame.seq <= this.seq) return false
    this.seq = frame.seq
    return true
  }
}
export function mayOperate(session, device) { return !!session && session.canOperate === true && session.readOnly !== true && device.capabilities.input === true }
export function mayWake(session, device) { return mayOperate(session, device) && session.state !== 'running' }
export function staleQuota(sampledAt, now = Date.now()) { return !sampledAt || !Number.isFinite(Date.parse(sampledAt)) || now - Date.parse(sampledAt) > 300000 }
export function agentLabel(agent) { return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Agente' }
export function sessionStateLabel(state) { return ({ running: 'Activa', sleeping: 'Suspendida', exited: 'Finalizada', interrupted: 'Interrumpida' })[state] ?? 'Estado no disponible' }
export function agentStateLabel(state) { return ({ working: 'Trabajando', waiting: 'Esperando', completed: 'Completado', unknown: 'Estado del agente no disponible' })[state] ?? 'Estado del agente no disponible' }
export function quotaStateLabel(state) { return ({ ready: 'Actualizada', stale: 'Desactualizada', unknown: 'Sin datos', unavailable: 'No disponible', unsupported: 'No disponible', error: 'No disponible', 'signed-out': 'Sin sesión', 'rate-limited': 'Límite temporal', 'reauth-required': 'Requiere iniciar sesión' })[state] ?? 'Estado no disponible' }
export function hostStateLabel(state) { return ({ connected: 'Conectado', connecting: 'Conectando', disconnected: 'Desconectado', error: 'Sin conexión' })[state] ?? 'Estado no disponible' }
