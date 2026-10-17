import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatProbe, advanceChatProbe, chatProbeReport, CHAT_PROBE_TIMEOUT_MS } from '../src/chat-probe.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const start = () => createChatProbe(id, 10, 100)
const user = probe => ({ role: 'user', seq: 11, content: probe.prompt })
const answer = probe => ({ role: 'assistant', seq: 12, content: probe.token })

test('a probe asks for one unique benign response and does not contain terminal commands', () => {
  const probe = start()
  assert.match(probe.prompt, /No uses herramientas ni ejecutes comandos/)
  assert.ok(probe.prompt.includes(probe.token))
  assert.equal(probe.outcome, 'running')
  assert.throws(() => createChatProbe('untrusted\ncommand', 0, 0))
})

test('PTY acknowledgement and unrelated agent activity never prove acceptance', () => {
  let probe = advanceChatProbe(start(), { type: 'written' }, 120)
  probe = advanceChatProbe(probe, { type: 'history', messages: [answer(probe), { ...user(probe), seq: 9 }] }, 140)
  assert.equal(probe.writtenAt, 120)
  assert.equal(probe.acceptedAt, null)
  assert.equal(probe.outcome, 'running')
  probe = advanceChatProbe(probe, { type: 'timeout' }, 100 + CHAT_PROBE_TIMEOUT_MS)
  assert.equal(probe.outcome, 'acceptance-timeout')
})

test('only the matching durable prompt followed by the exact response passes', () => {
  let probe = start()
  probe = advanceChatProbe(probe, { type: 'history', messages: [user(probe)] }, 150)
  probe = advanceChatProbe(probe, { type: 'history', messages: [answer(probe)] }, 300)
  assert.equal(probe.outcome, 'passed')
  assert.equal(probe.acceptedAt, 150)
  assert.equal(probe.answeredAt, 300)
  probe = advanceChatProbe(probe, { type: 'written' }, 310) // ACK may arrive after history.
  assert.equal(probe.outcome, 'passed')
  assert.equal(probe.writtenAt, 310)
  probe = advanceChatProbe(probe, { type: 'send-error' }, 320)
  assert.equal(probe.outcome, 'passed')
  assert.equal(probe.sendError, true)
})

test('unknown send results remain observable without retrying; later history can resolve them', () => {
  let probe = advanceChatProbe(start(), { type: 'send-error' }, 120)
  assert.equal(probe.outcome, 'running')
  probe = advanceChatProbe(probe, { type: 'history', messages: [user(probe), answer(probe)] }, 400)
  assert.equal(probe.outcome, 'passed')
  assert.equal(chatProbeReport(probe).sendError, true)
})

test('timeout distinguishes missing acceptance, missing answer and an unexpected answer', () => {
  const accepted = advanceChatProbe(start(), { type: 'history', messages: [user(start())] }, 150)
  assert.equal(advanceChatProbe(accepted, { type: 'timeout' }, 100000).outcome, 'response-timeout')
  const wrong = advanceChatProbe(accepted, { type: 'history', messages: [{ role: 'assistant', seq: 12, content: 'another response' }] }, 200)
  assert.equal(advanceChatProbe(wrong, { type: 'timeout' }, 100000).outcome, 'unexpected-response')
  const cancelled = advanceChatProbe(accepted, { type: 'cancelled' }, 180)
  assert.equal(advanceChatProbe(cancelled, { type: 'history', messages: [answer(accepted)] }, 200).outcome, 'cancelled')
  assert.equal(advanceChatProbe(start(), { type: 'rejected' }, 110).outcome, 'not-sent')
})

test('export explicitly allowlists diagnostic measurements, never transcript or credentials', () => {
  const probe = { ...start(), endpoint: 'secret-url', tokenSecret: 'secret', prompt: 'private transcript', error: 'Authorization Bearer secret' }
  const report = chatProbeReport(probe)
  assert.deepEqual(Object.keys(report).sort(), ['acceptedMs', 'outcome', 'responseMs', 'schema', 'sendError', 'testId', 'totalMs', 'writtenMs'].sort())
  assert.doesNotMatch(JSON.stringify(report), /secret|private transcript/)
})
