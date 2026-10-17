import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { singleLineChatInput } from '../src/chat-model.mjs'
import { inputByteLength, MAX_INPUT_BYTES } from '../src/protocol.mjs'
import { chatSubmitBody, chatSubmitStatusPath, normalizeChatSubmitResult, chatSubmitErrorMessage, isUnsupportedChatSubmitError, chatSubmissionStorageKey } from '../src/chat-submit.mjs'

const source = readFileSync(new URL('../src/ChatView.tsx', import.meta.url), 'utf8')
function chatActions(send, agent = 'claude') {
  const calls = [], state = { draft: 'Hello\nworld', outgoing: null, awaiting: false, sending: false, error: '', notice: '', refresh: [] }
  const submission = { current: null }
  const lastUncertainText = { current: '' }
  const set = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value }
  const stored = new Map()
  const context = {
    draft: state.draft, sending: false, canSend: true, sendLock: { current: false }, connection: { current: 'stream' },
    cursor: { current: 10 }, list: { current: { scrollTop: 0, scrollHeight: 100 } }, followLatest: { current: false },
    replyPending: { current: null }, messages: [{ role: 'assistant', seq: 10 }],
    session: { agent, id: 'session-1' }, hostId: 'host-1', profile: { id: 'profile-1' }, agentName: () => agent === 'codex' ? 'Codex' : 'Claude Code', singleLineChatInput, inputByteLength, MAX_INPUT_BYTES,
    api: async (profileId, path, method, body) => { const request = { profileId, path, method, body }; calls.push(request); return await send(request) },
    chatSubmitBody, chatSubmitStatusPath, normalizeChatSubmitResult, chatSubmitErrorMessage, isUnsupportedChatSubmitError,
    submission, lastUncertainText, submissionKey: 'test-operation', clearSubmission: () => { submission.current = null },
    crypto: { randomUUID: () => 'b915d4aa-5d19-4a58-91f0-8b80559c3ae2' },
    sessionStorage: { setItem(key, value) { stored.set(key, value) }, removeItem(key) { stored.delete(key) }, getItem(key) { return stored.get(key) || null } },
    setSending: set('sending'), setError: set('error'), setNotice: set('notice'), setUnread() {}, setAwaitingAgent: set('awaiting'), setOutgoing: set('outgoing'), setDraft: set('draft'), setManualSendOverride() {}, setSubmissionAccepted() {},
    fetchPage: async mode => state.refresh.push(mode),
  }
  const methods = source.slice(source.indexOf('  async function send('), source.indexOf('  function startProbe('))
  vm.runInNewContext(ts.transpileModule(methods + '\nglobalThis.sendChat = send;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { send: context.sendChat, calls, state, context, stored }
}

test('Codex uses the same structured chat contract without raw terminal fallback', async () => {
  const action = chatActions(async request => ({ operationId: 'op-codex', requestId: request.body.requestId, sessionId: 'session-1', status: 'pending' }), 'codex')
  await action.send()
  assert.equal(action.calls.length, 1)
  assert.equal(action.calls[0].path, '/api/v2/chat-submit')
  assert.equal(action.state.error, '')
})

test('chat shows pending text immediately, posts one structured operation, and never submits twice', async () => {
  let acknowledge
  const action = chatActions(request => new Promise(resolve => { acknowledge = () => resolve({ operationId: 'op-1', requestId: request.body.requestId, sessionId: request.body.sessionId, status: 'written' }) }))
  const work = action.send()
  assert.equal(action.state.outgoing.status, 'sending')
  assert.equal(action.state.outgoing.content, 'Hello world')
  assert.equal(action.state.awaiting, true)
  assert.equal(action.state.draft, 'Hello\nworld')
  await action.send()
  assert.equal(action.calls.length, 1)
  assert.equal(action.calls[0].path, '/api/v2/chat-submit')
  assert.equal(action.calls[0].method, 'POST')
  assert.deepEqual(action.calls[0].body, { hostId: 'host-1', sessionId: 'session-1', requestId: 'b915d4aa-5d19-4a58-91f0-8b80559c3ae2', text: 'Hello world' })
  action.state.draft = 'Next instruction drafted while waiting'
  acknowledge(); await work
  assert.equal(action.state.outgoing.status, 'delivered')
  assert.equal(action.state.draft, 'Next instruction drafted while waiting')
  assert.deepEqual(action.state.refresh, ['initial'])
})

test('ambiguous structured-submit failure stays visible and blocked for review without reposting', async () => {
  const action = chatActions(async () => { throw 'Transport unavailable' })
  await action.send()
  assert.equal(action.calls.length, 1)
  assert.equal(action.state.outgoing.status, 'unknown')
  assert.equal(action.state.awaiting, true)
  assert.equal(action.state.draft, 'Hello\nworld')
  assert.match(action.state.error, /Verificá el estado en Chat/)
  assert.equal(action.stored.get('test-operation'), 'b915d4aa-5d19-4a58-91f0-8b80559c3ae2')
  await action.send()
  assert.equal(action.calls.length, 1)
})

test('pending response keeps stable ID and draft for read-only reconciliation', async () => {
  const action = chatActions(request => ({ operationId: 'op-1', requestId: request.body.requestId, sessionId: request.body.sessionId, status: 'pending' }))
  await action.send()
  assert.equal(action.state.outgoing.status, 'unknown')
  assert.equal(action.state.awaiting, true)
  assert.equal(action.state.draft, 'Hello\nworld')
  assert.equal(action.stored.get('test-operation'), 'b915d4aa-5d19-4a58-91f0-8b80559c3ae2')
  await action.send()
  assert.equal(action.calls.length, 1)
})

test('unsupported structured endpoint gives update guidance and never falls back to terminal input', async () => {
  const action = chatActions(async () => { throw Object.assign(new Error('HTTP 501'), { code: 'STRUCTURED_CHAT_UNAVAILABLE' }) })
  await action.send()
  assert.equal(action.calls.length, 1)
  assert.equal(action.calls[0].path, '/api/v2/chat-submit')
  assert.equal(action.state.awaiting, false)
  assert.equal(action.state.draft, 'Hello\nworld')
  assert.match(action.state.error, /Actualizá Crow/)
  assert.doesNotMatch(source.slice(source.indexOf('  async function send('), source.indexOf('  function startProbe(')), /Gateway\.send/)
})

test('structured preflight rejection is not mislabeled as a possibly written operation', async () => {
  const action = chatActions(async () => ({ operationId: 'op-1', requestId: 'b915d4aa-5d19-4a58-91f0-8b80559c3ae2', sessionId: 'session-1', status: 'rejected' }))
  await action.send()
  assert.equal(action.state.outgoing.status, 'failed')
  assert.equal(action.state.awaiting, false)
  assert.equal(action.calls.length, 1)
})

test('a lost HTTP acknowledgement does not become an unknown send after the user hook confirmed receipt', async () => {
  let reject
  const action = chatActions(() => new Promise((_, no) => { reject = no }))
  const work = action.send()
  action.context.replyPending.current.userSeq = 11
  action.state.outgoing.status = 'unknown'
  reject('Lost response'); await work
  assert.equal(action.state.error, '')
  assert.equal(action.state.draft, '')
  assert.equal(action.state.outgoing.status, 'unknown')
  assert.equal(action.calls.length, 1)
  assert.equal(action.context.submission.current, null)
})
