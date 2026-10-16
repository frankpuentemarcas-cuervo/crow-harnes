import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatSync } from '../src/chat-sync.mjs'
import { chatInputAllowed, chatReplyProgress, confirmedChatEcho } from '../src/chat-model.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const page = (messages = [], hasMore = false) => ({ messages, hasMore })

test('state changes received during a history read are coalesced, not lost', async () => {
  const first = deferred(), reads = [], accepted = []
  const sync = createChatSync({ read: mode => { reads.push(mode); return reads.length === 1 ? first.promise : Promise.resolve(page([{ seq: 2 }])) }, accept: p => accepted.push(p), error: assert.fail })
  const work = sync.request('initial')
  sync.request('newer'); sync.request('newer')
  first.resolve(page([{ seq: 1 }]))
  await work
  assert.deepEqual(reads, ['initial', 'newer'])
  assert.equal(accepted.length, 2)
})

test('newer pagination drains immediately and falls back to latest tail for large backlogs', async () => {
  const modes = []
  const sync = createChatSync({ read: async mode => { modes.push(mode); return page([{ seq: modes.length }], true) }, accept() {}, error: assert.fail })
  await sync.request()
  assert.deepEqual(modes, ['newer', 'newer', 'initial'])
})

test('latest tail request takes priority and disposed requests never publish stale state', async () => {
  const first = deferred(), modes = [], accepted = []
  const sync = createChatSync({ read: mode => { modes.push(mode); return modes.length === 1 ? first.promise : Promise.resolve(page()) }, accept: (_, m) => accepted.push(m), error: assert.fail })
  const work = sync.request('newer'); sync.request('initial'); sync.request('newer')
  first.resolve(page()); await work
  assert.deepEqual(modes, ['newer', 'initial'])
  const pending = deferred()
  const stopped = createChatSync({ read: () => pending.promise, accept: assert.fail, error: assert.fail, loading() {} })
  const read = stopped.request(); stopped.dispose(); pending.resolve(page()); await read
})

test('unknown agent state does not disable authorized chat, but confirmed work and read-only do', () => {
  const session = { canOperate: true, state: 'running', agentState: 'unknown' }
  assert.equal(chatInputAllowed(session, { input: true }, true, false), true)
  assert.equal(chatInputAllowed({ ...session, agentState: 'working' }, { input: true }, true, false), false)
  assert.equal(chatInputAllowed(session, { input: false }, true, false), false)
  assert.equal(chatInputAllowed({ ...session, readOnly: true }, { input: true }, true, false, true), false)
  assert.equal(chatInputAllowed(session, { input: true }, false, false), false)
  assert.equal(chatInputAllowed(session, { input: true }, true, true), false)
})

test('optimistic message is hidden only by a newer matching user echo, not a previous identical turn', () => {
  const outgoing = { content: 'hello world', afterSeq: 10 }
  assert.equal(confirmedChatEcho(outgoing, [{ role: 'user', seq: 9, content: 'hello world' }]), false)
  assert.equal(confirmedChatEcho(outgoing, [{ role: 'assistant', seq: 11, content: 'hello world' }]), false)
  assert.equal(confirmedChatEcho(outgoing, [{ role: 'user', seq: 11, content: 'hello\nworld' }]), true)
})

test('reply confirmation survives separate pages but does not confuse a pre-existing answer with the submitted turn', () => {
  const pending = { content: 'new turn', afterSeq: 10 }
  assert.equal(chatReplyProgress(pending, [{ role: 'assistant', seq: 11, content: 'previous reply' }]).answered, false)
  const seen = chatReplyProgress(pending, [{ role: 'user', seq: 12, content: 'new turn' }])
  assert.equal(seen.userSeq, 12)
  assert.equal(seen.answered, false)
  assert.equal(chatReplyProgress(seen, [{ role: 'assistant', seq: 13, content: 'new reply' }]).answered, true)
})
