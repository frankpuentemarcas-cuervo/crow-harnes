import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { definiteChatSendFailure, singleLineChatInput } from '../src/chat-model.mjs'
import { encodeInput, inputByteLength, MAX_INPUT_BYTES } from '../src/protocol.mjs'

const source = readFileSync(new URL('../src/ChatView.tsx', import.meta.url), 'utf8')
function chatActions(send) {
  const calls = [], state = { draft: 'Hello\nworld', outgoing: null, awaiting: false, sending: false, error: '', notice: '', refresh: [] }
  const set = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value }
  const context = {
    draft: state.draft, sending: false, canSend: true, sendLock: { current: false }, connection: { current: 'stream' },
    cursor: { current: 10 }, list: { current: { scrollTop: 0, scrollHeight: 100 } }, followLatest: { current: false },
    sawAgentBusy: { current: false }, replyPending: { current: null }, messages: [{ role: 'assistant', seq: 10 }],
    session: { agent: 'claude' }, agentName: () => 'Claude Code', singleLineChatInput, definiteChatSendFailure, encodeInput, inputByteLength, MAX_INPUT_BYTES,
    Gateway: { send: async value => { calls.push(value); return send(value) } },
    setSending: set('sending'), setError: set('error'), setNotice: set('notice'), setUnread() {}, setAwaitingAgent: set('awaiting'), setOutgoing: set('outgoing'), setDraft: set('draft'), setManualSendOverride() {},
    fetchPage: async mode => state.refresh.push(mode),
  }
  const methods = source.slice(source.indexOf('  async function send()'), source.indexOf('  async function copyCode('))
  vm.runInNewContext(ts.transpileModule(methods + '\nglobalThis.sendChat = send;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { send: context.sendChat, calls, state, context }
}

test('chat shows pending text immediately, confirms only after PTY acknowledgement, never submits twice', async () => {
  let acknowledge
  const action = chatActions(() => new Promise(resolve => { acknowledge = resolve }))
  const work = action.send()
  assert.equal(action.state.outgoing.status, 'sending')
  assert.equal(action.state.outgoing.content, 'Hello world')
  assert.equal(action.state.awaiting, true)
  assert.equal(action.state.draft, 'Hello\nworld')
  await action.send()
  assert.equal(action.calls.length, 1)
  assert.equal(action.calls[0].data, encodeInput('Hello world\r'))
  action.state.draft = 'Next instruction drafted while waiting'
  acknowledge(); await work
  assert.equal(action.state.outgoing.status, 'delivered')
  assert.equal(action.state.draft, 'Next instruction drafted while waiting')
  assert.deepEqual(action.state.refresh, ['initial'])
})

test('ambiguous send failure stays visible and blocked for review without retrying', async () => {
  const action = chatActions(async () => { throw 'Transport unavailable' })
  await action.send()
  assert.equal(action.calls.length, 1)
  assert.equal(action.state.outgoing.status, 'unknown')
  assert.equal(action.state.awaiting, true)
  assert.equal(action.state.draft, 'Hello\nworld')
  assert.match(action.state.error, /Verificá la conversación/)
})

test('native preflight rejection is not mislabeled as a possibly delivered command', async () => {
  const action = chatActions(async () => { throw 'Terminal desconectada o de solo lectura. No se envió el texto.' })
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
  action.state.outgoing.status = 'processing'
  reject('Lost response'); await work
  assert.equal(action.state.error, '')
  assert.equal(action.state.draft, '')
  assert.equal(action.state.outgoing.status, 'processing')
  assert.equal(action.calls.length, 1)
})
