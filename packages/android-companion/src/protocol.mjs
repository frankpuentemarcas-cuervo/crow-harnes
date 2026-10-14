export function parseEnrollment(raw, now = Date.now()) {
  const value = JSON.parse(raw)
  if (value?.version === 1) throw new Error('Esta invitación usa el protocolo anterior. Actualizá Crow en Windows y generá un nuevo QR; tus perfiles anteriores no se convierten automáticamente.')
  if (value?.version !== 2 || typeof value.gatewayId !== 'string' || !value.gatewayId || typeof value.invitationCode !== 'string' || !value.invitationCode || !Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 8 || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now) throw new Error('Invitación inválida o vencida. Generá otra desde Crow en Windows.')
  if (Object.keys(value).some(key => !['version', 'gatewayId', 'invitationCode', 'expiresAt', 'endpoints'].includes(key))) throw new Error('La invitación no puede incluir credenciales del proxy.')
  for (const endpoint of value.endpoints) {
    if (Object.keys(endpoint).some(key => !['kind', 'url', 'certSHA256', 'provider', 'proxyAuthRequired', 'relayUrl', 'relayRoute', 'proxyAuth'].includes(key))) throw new Error('El endpoint de invitación contiene campos desconocidos.')
    const url = new URL(endpoint.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/' || !['lan-pinned', 'remote-public', 'relay'].includes(endpoint.kind)) throw new Error('El endpoint debe ser un origen HTTPS exacto.')
    if (['lan-pinned', 'relay'].includes(endpoint.kind) && !/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(endpoint.certSHA256 ?? '')) throw new Error('Falta la huella SHA-256 válida del certificado fijado.')
    if (endpoint.kind === 'relay') {
      let relay
      try { relay = new URL(endpoint.relayUrl) } catch { throw new Error('URL de relay inválida.') }
      const route = endpoint.relayRoute ?? ''
      const decodedRoute = /^[A-Za-z0-9_-]{43}$/.test(route) ? atob(route.replace(/-/g, '+').replace(/_/g, '/') + '=') : ''
      const canonicalRoute = decodedRoute.length === 32 && btoa(decodedRoute).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === route
      if (url.hostname !== '127.0.0.1' || !url.port || relay.protocol !== 'wss:' || relay.username || relay.password || relay.pathname !== '/v1/tunnel' || relay.search || relay.hash || !canonicalRoute) throw new Error('Configuración de relay E2E inválida.')
    } else if ('relayUrl' in endpoint || 'relayRoute' in endpoint) throw new Error('La ruta y URL de relay solo son válidas en un endpoint relay.')
    if ('provider' in endpoint || 'proxyAuthRequired' in endpoint) {
      if (endpoint.provider !== 'pangolin' || endpoint.proxyAuthRequired !== true || endpoint.kind !== 'remote-public' || !/^https:\/\/[a-z0-9.-]+\/?$/.test(endpoint.url) || !url.hostname.includes('.') || !/\.[a-z]{2,63}$/.test(url.hostname) || /\.(localhost|local|internal)$/.test(url.hostname) || url.hostname.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new Error('Pangolin requiere dominio HTTPS exacto y autenticación nativa.')
      const auth = endpoint.proxyAuth
      if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).some(key => !['origin', 'tokenId', 'token'].includes(key)) || auth.origin !== url.origin || !validPangolinHeader(auth.tokenId, 128) || !validPangolinHeader(auth.token, 1024)) throw new Error('El QR no contiene un token Pangolin válido para este dominio.')
    } else if ('proxyAuth' in endpoint) throw new Error('Solo los endpoints Pangolin admiten credenciales de recurso.')
  }
  return value
}
export function parseEnrollmentBundle(raw, now = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 16384) throw new Error('El QR es demasiado grande.')
  const value = JSON.parse(raw)
  if (value?.version !== 3 || !Array.isArray(value.enrollments) || value.enrollments.length < 2 || value.enrollments.length > 16 || Object.keys(value).some(key => !['version', 'enrollments'].includes(key))) throw new Error('Este QR no contiene un vínculo completo de Crow.')
  const ids = new Set()
  const enrollments = value.enrollments.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['hostId', 'hostName', 'enrollment'].includes(key)) || typeof item.hostId !== 'string' || !/^[A-Za-z0-9._~-]{1,200}$/.test(item.hostId) || typeof item.hostName !== 'string' || item.hostName.length < 1 || item.hostName.length > 80) throw new Error('Host inválido en el QR.')
    const enrollment = parseEnrollment(JSON.stringify(item.enrollment), now)
    if (ids.has(enrollment.gatewayId)) throw new Error('El QR repite un gateway.')
    ids.add(enrollment.gatewayId)
    return { hostId: item.hostId, hostName: item.hostName, enrollment }
  })
  return enrollments
}
export async function decodeEnrollmentQR(raw, now = Date.now()) {
  if (!raw.startsWith('crow3:')) return parseEnrollmentBundle(raw, now)
  const encoded = raw.slice(6)
  if (!/^[A-Za-z0-9_-]{1,12000}$/.test(encoded)) throw new Error('QR comprimido inválido.')
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4))
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (typeof DecompressionStream === 'undefined') throw new Error('Actualizá Android WebView para leer este QR.')
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 16384) throw new Error('El QR descomprimido es demasiado grande.')
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return parseEnrollmentBundle(new TextDecoder().decode(result), now)
}
function validPangolinHeader(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && /^[!-~]+$/.test(value) }
export const MAX_INPUT_BYTES = 2048
export function inputByteLength(text) { return new TextEncoder().encode(text).length }
export function encodeInput(text) { const bytes = new TextEncoder().encode(text); if (bytes.length > MAX_INPUT_BYTES) throw new Error('El envío supera 2048 bytes UTF-8. Acortá el texto: no se divide ni se envía automáticamente.'); return btoa(String.fromCharCode(...bytes)) }
export function decodeOutput(text) { return Uint8Array.from(atob(text), character => character.charCodeAt(0)) }
export class OutputCursor {
  seq = 0
  lastGap = false
  accept(frame) {
    this.lastGap = false
    if (frame.type !== 'output' || typeof frame.data !== 'string' || !Number.isSafeInteger(frame.seq) || frame.seq <= this.seq) return false
    this.lastGap = frame.seq > this.seq + 1
    this.seq = frame.seq
    return true
  }
}
export function mayOperate(session, device) { return !!session && session.canOperate === true && session.readOnly !== true && device.capabilities.input === true }
export function mayWake(session, device) { return mayOperate(session, device) && session.state !== 'running' }
export function staleQuota(sampledAt, now = Date.now()) { return !sampledAt || !Number.isFinite(Date.parse(sampledAt)) || now - Date.parse(sampledAt) > 300000 }
export function agentLabel(agent) { return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Agente' }
export function terminalTitle(session) { return typeof session?.name === 'string' && session.name.trim() ? session.name.trim() : `${agentLabel(session?.agent)} · ${String(session?.id || '').slice(0, 8)}` }
export function sessionStateLabel(state) { return ({ running: 'Activa', sleeping: 'Suspendida', exited: 'Finalizada', interrupted: 'Interrumpida' })[state] ?? 'Estado no disponible' }
export function agentStateLabel(state) { return ({ working: 'Trabajando', waiting: 'Esperando', completed: 'Completado', unknown: 'Estado del agente no disponible' })[state] ?? 'Estado del agente no disponible' }
export function quotaStateLabel(state) { return ({ ready: 'Actualizada', stale: 'Desactualizada', unknown: 'Sin datos', unavailable: 'No disponible', unsupported: 'No disponible', error: 'No disponible', 'signed-out': 'Sin sesión', 'rate-limited': 'Límite temporal', 'reauth-required': 'Requiere iniciar sesión' })[state] ?? 'Estado no disponible' }
export function hostStateLabel(state) { return ({ connected: 'Conectado', connecting: 'Conectando', disconnected: 'Desconectado', error: 'Sin conexión' })[state] ?? 'Estado no disponible' }
