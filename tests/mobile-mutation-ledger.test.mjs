import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
const source = stripTypeScriptTypes(readFileSync(new URL('../src/main/mobile-mutation-ledger.ts', import.meta.url), 'utf8'), { mode: 'transform' })
const { MobileMutationLedger } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const context = (expiresAt = Date.now() + 60_000) => ({ id: randomUUID(), deviceId: 'device', expiresAt })
test('same contextual attempt coalesces concurrently and returns immutable identical results', async () => {
  const ledger = new MobileMutationLedger(), ctx = context(), id = randomUUID()
  let count = 0, resolve
  const gate = new Promise(done => resolve = done)
  const action = async () => { count++; await gate; return { status: 200, body: { id: 'session' } } }
  const first = ledger.run(ctx, id, 'sessions', { requestId: id, projectId: 'project', hostId: 'host' }, action)
  const second = ledger.run(ctx, id, 'sessions', { hostId: 'host', projectId: 'project', requestId: id }, action)
  await new Promise(ok => setImmediate(ok)); assert.equal(count, 1); resolve()
  const results = await Promise.all([first, second]); assert.deepEqual(results[0], results[1])
  results[0].body.id = 'modified'
  assert.equal((await ledger.run(ctx, id, 'sessions', { requestId: id, projectId: 'project', hostId: 'host' }, action)).body.id, 'session')
  assert.equal(count, 1)
  await assert.rejects(ledger.run(ctx, id, 'sessions', { projectId: 'other' }, action), error => error.status === 409)
  await assert.rejects(ledger.run(ctx, id, 'close', { requestId: id, projectId: 'project', hostId: 'host' }, action), error => error.status === 409)
})
test('ambiguous failure or timeout becomes a tombstone, never another execution', async () => {
  for (const failure of ['error', 'timeout']) {
    const ledger = new MobileMutationLedger({ timeoutMs: 5 }), ctx = context(), id = randomUUID()
    let count = 0, finish
    const pending = new Promise(done => finish = done)
    const action = async () => { count++; if (failure === 'error') throw new Error('private failure'); await pending; return { status: 200, body: {} } }
    const first = await ledger.run(ctx, id, 'input', { data: 'aGk=' }, action)
    assert.equal(first.status, 502); assert.equal(JSON.stringify(first).includes('private failure'), false)
    const replay = await ledger.run(ctx, id, 'input', { data: 'aGk=' }, action)
    assert.deepEqual(replay, first); assert.equal(count, 1)
    finish(); await new Promise(ok => setImmediate(ok))
    assert.deepEqual(await ledger.run(ctx, id, 'input', { data: 'aGk=' }, action), first, 'late success never removes the uncertain tombstone')
  }
})
test('capacity rejects new attempts without evicting accepted tombstones; TTL only removes retired contexts', async () => {
  let now = 1000
  const ledger = new MobileMutationLedger({ now: () => now, skewMs: 100, maxPerContext: 1, maxContexts: 1 }), ctx = context(2000), id = randomUUID()
  let count = 0
  const action = async () => { count++; return { status: 200, body: {} } }
  await ledger.run(ctx, id, 'wake', {}, action)
  await assert.rejects(ledger.run(ctx, randomUUID(), 'wake', {}, action), error => error.status === 429)
  await ledger.run(ctx, id, 'wake', {}, action); assert.equal(count, 1)
  now = 2001
  await assert.rejects(ledger.run(ctx, id, 'wake', {}, action), error => error.status === 401)
  await assert.rejects(ledger.run(context(3000), randomUUID(), 'wake', {}, action), error => error.status === 429, 'skew margin keeps prior context tombstones')
  now = 2101
  await ledger.run(context(3000), randomUUID(), 'wake', {}, action)
  assert.equal(count, 2)
  await assert.rejects(ledger.run(ctx, id, 'wake', {}, action), error => error.status === 401, 'expired context cannot execute after pruning')
})
test('invalid IDs, response-size and global concurrency bounds remain fail closed', async () => {
  const ledger = new MobileMutationLedger({ maxInFlight: 1 }), ctx = context()
  let done
  const gate = new Promise(resolve => done = resolve)
  await assert.rejects(ledger.run(ctx, 'not-uuid', 'close', {}, async () => ({ status: 200, body: {} })), error => error.status === 400)
  const pending = ledger.run(ctx, randomUUID(), 'close', {}, async () => { await gate; return { status: 200, body: {} } })
  await assert.rejects(ledger.run(ctx, randomUUID(), 'close', {}, async () => ({ status: 200, body: {} })), error => error.status === 429)
  done(); await pending
  const id = randomUUID()
  const result = await ledger.run(ctx, id, 'sessions', {}, async () => ({ status: 200, body: 'secret'.repeat(9000) }))
  assert.equal(result.status, 502)
  assert.deepEqual(await ledger.run(ctx, id, 'sessions', {}, async () => { throw new Error('must not execute') }), result)
})
