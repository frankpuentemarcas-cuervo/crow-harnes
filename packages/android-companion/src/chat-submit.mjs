const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STATUSES = new Set(['pending', 'written', 'accepted', 'uncertain', 'rejected', 'unknown'])
const TRANSPORT_CODES = new Set(['CROW_TRANSPORT_TLS', 'CROW_TRANSPORT_TIMEOUT', 'CROW_TRANSPORT_RELAY_PEER_CLOSED', 'CROW_TRANSPORT_CANCELED', 'CROW_TRANSPORT_NETWORK_IO'])
const TRANSPORT_STAGES = new Set(['renew', 'request', 'connect', 'send', 'stream', 'response'])

export function chatTransportErrorMessage(event) {
  if (!event || !TRANSPORT_CODES.has(event.errorCode) || !TRANSPORT_STAGES.has(event.stage)) return ''
  return `La conexión segura se interrumpió durante ${event.stage}. El envío no se repite automáticamente; verificá su estado en Chat.`
}

export function chatSubmitBody({ hostId, sessionId, requestId, text }) {
  if (typeof hostId !== 'string' || !hostId || typeof sessionId !== 'string' || !sessionId || !UUID_V4.test(requestId) || typeof text !== 'string' || !text.trim()) throw new Error('La solicitud de chat no es válida.')
  return { hostId, sessionId, requestId, text }
}

export function chatSubmitStatusPath({ hostId, sessionId, requestId }) {
  const query = new URLSearchParams()
  query.set('hostId', hostId)
  query.set('sessionId', sessionId)
  query.set('requestId', requestId)
  return `/api/v2/chat-submit?${query}`
}

export function normalizeChatSubmitResult(value, expected) {
  if (!value || typeof value !== 'object' || typeof value.operationId !== 'string' || (value.status !== 'unknown' && !value.operationId) || value.requestId !== expected.requestId || value.sessionId !== expected.sessionId) throw new Error('La respuesta del envío no coincide con esta operación.')
  if (!STATUSES.has(value.status)) throw new Error('Crow devolvió un estado de envío desconocido.')
  return { operationId: value.operationId, requestId: value.requestId, sessionId: value.sessionId, status: value.status }
}

export function chatSubmitErrorMessage(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error?.message || '')
  if (code === 'STRUCTURED_CHAT_UNAVAILABLE' || /HTTP\s+501|structured chat unavailable|historial de chat no está disponible/i.test(message)) return 'Esta versión de Crow todavía no admite envíos seguros desde Chat. Actualizá Crow y la app móvil; no se envió por la terminal.'
  if (code === 'REQUEST_CONFLICT' || /HTTP\s+409/.test(message)) return 'El identificador de esta operación ya está asociado a otro envío. Verificá el historial antes de intentar de nuevo.'
  return `${message || 'No se pudo confirmar el envío.'} Verificá el estado en Chat antes de intentar otra vez; no se reenvía automáticamente.`
}

export function isUnsupportedChatSubmitError(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error?.message || '')
  return code === 'STRUCTURED_CHAT_UNAVAILABLE' || /HTTP\s+501|structured chat unavailable|historial de chat no está disponible/i.test(message)
}

export function chatSubmissionStorageKey(profileId, hostId, sessionId) {
  return `crow-chat-submit:${encodeURIComponent(profileId)}:${encodeURIComponent(hostId)}:${encodeURIComponent(sessionId)}`
}

export function readStoredChatRequestId(storage, key) {
  try {
    const value = storage.getItem(key)
    return UUID_V4.test(value || '') ? value : null
  } catch { return null }
}
