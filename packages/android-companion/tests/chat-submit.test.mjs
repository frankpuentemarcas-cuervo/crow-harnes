import test from 'node:test'
import assert from 'node:assert/strict'
import { chatSubmitBody, chatSubmitStatusPath, normalizeChatSubmitResult, chatSubmitErrorMessage, chatTransportErrorMessage, chatSubmissionStorageKey, readStoredChatRequestId } from '../src/chat-submit.mjs'

const operation = { hostId: 'linux-1', sessionId: 'session-2', requestId: 'b915d4aa-5d19-4a58-91f0-8b80559c3ae2', text: 'hello' }

test('structured submit carries a stable operation UUID and status URL has canonical query order', () => {
  assert.deepEqual(chatSubmitBody(operation), operation)
  assert.equal(chatSubmitStatusPath(operation), '/api/v2/chat-submit?hostId=linux-1&sessionId=session-2&requestId=b915d4aa-5d19-4a58-91f0-8b80559c3ae2')
})

test('status accepts only matching operation identity and known lifecycle values', () => {
  const result = normalizeChatSubmitResult({ operationId: 'op-1', requestId: operation.requestId, sessionId: operation.sessionId, status: 'written' }, operation)
  assert.equal(result.status, 'written')
  assert.equal(normalizeChatSubmitResult({ operationId: '', requestId: operation.requestId, sessionId: operation.sessionId, status: 'unknown' }, operation).status, 'unknown')
  assert.equal(normalizeChatSubmitResult({ operationId: 'op-1', requestId: operation.requestId, sessionId: operation.sessionId, status: 'accepted' }, operation).status, 'accepted')
  assert.equal(normalizeChatSubmitResult({ operationId: 'op-1', requestId: operation.requestId, sessionId: operation.sessionId, status: 'rejected' }, operation).status, 'rejected')
  assert.throws(() => normalizeChatSubmitResult({ operationId: 'op-1', requestId: 'other', sessionId: operation.sessionId, status: 'accepted' }, operation), /no coincide/)
  assert.throws(() => normalizeChatSubmitResult({ operationId: 'op-1', requestId: operation.requestId, sessionId: operation.sessionId, status: 'sent' }, operation), /estado/)
})

test('native disconnect diagnostics are allowlisted and never expose arbitrary event text', () => {
  assert.match(chatTransportErrorMessage({ errorCode: 'CROW_TRANSPORT_TIMEOUT', stage: 'stream' }), /conexión segura.*stream/i)
  assert.equal(chatTransportErrorMessage({ errorCode: 'SOMETHING_ELSE', stage: 'stream', message: 'secret' }), '')
  assert.equal(chatTransportErrorMessage({ errorCode: 'CROW_TRANSPORT_TLS', stage: 'password', message: 'secret' }), '')
})

test('unsupported structured chat endpoint asks for update and never suggests terminal fallback', () => {
  assert.match(chatSubmitErrorMessage({ code: 'STRUCTURED_CHAT_UNAVAILABLE' }), /actualizá Crow/i)
  assert.match(chatSubmitErrorMessage({ message: 'HTTP 501: unsupported' }), /actualizá Crow/i)
  assert.match(chatSubmitErrorMessage({ message: 'El historial de chat no está disponible para esta sesión.' }), /actualizá Crow/i)
  assert.match(chatSubmitErrorMessage(new Error('lost connection')), /verificá el estado/i)
  assert.doesNotMatch(chatSubmitErrorMessage({ code: 'STRUCTURED_CHAT_UNAVAILABLE' }), /podés usar la terminal|reenviar por terminal/i)
})

test('view restoration stores only a profile/host/session-scoped UUID, never prompt text', () => {
  const key = chatSubmissionStorageKey('profile/a', 'linux 1', 'session?2')
  assert.equal(key, 'crow-chat-submit:profile%2Fa:linux%201:session%3F2')
  const storage = { getItem: name => name === key ? operation.requestId : null }
  assert.equal(readStoredChatRequestId(storage, key), operation.requestId)
  assert.equal(readStoredChatRequestId({ getItem: () => 'not-a-uuid' }, key), null)
  assert.equal(readStoredChatRequestId({ getItem: () => { throw new Error('storage disabled') } }, key), null)
})
