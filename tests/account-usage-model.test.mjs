import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { AccountUsageController, ACCOUNT_USAGE_REFRESH_MS, quotaSampleIsStale, quotaWindowIsStale } from '../src/renderer/src/account-usage-model.ts'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const account = (patch = {}) => ({ id: 'work', provider: 'claude', label: 'TRABAJO', status: 'stale', windows: [{ id: 'session', label: 'Sesión', usedPercent: 0 }], updatedAt: 10, ...patch })

function setup(rows = [account()], overrides = {}) {
  let now = 1_800_000_000_000, visible = true, serial = 0
  const timers = new Map(), visibility = new Set(), calls = []
  let accounts = structuredClone(rows)
  const api = {
    accountsList: async () => { calls.push('list'); return structuredClone(accounts) },
    accountsRefresh: async id => { calls.push(`refresh:${id}`); const item = account({ ...accounts.find(item => item.id === id), status: 'ready', updatedAt: now }); accounts = accounts.map(row => row.id === id ? item : row); return structuredClone(item) },
    accountsLogin: async id => { calls.push(`login:${id}`); return account({ id, status: 'ready', updatedAt: now }) },
    accountsAdd: async input => { calls.push('add'); const item = account({ ...input, id: 'new', status: 'signed-out', windows: [], updatedAt: undefined }); accounts.push(item); return item },
    accountsRemove: async id => { calls.push(`remove:${id}`); accounts = accounts.filter(item => item.id !== id) },
    ...overrides
  }
  const model = new AccountUsageController(api, {
    now: () => now, visible: () => visible,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id },
    clearTimer: id => timers.delete(id),
    onVisibility: callback => { visibility.add(callback); return () => visibility.delete(callback) }
  })
  return {
    model, calls, timers, visibility,
    now: () => now,
    hide: () => { visible = false; for (const callback of visibility) callback() },
    show: () => { visible = true; for (const callback of visibility) callback() },
    advance: async ms => { const target = now + ms; while (true) { const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush() } now = target; await flush() }
  }
}

test('persistent controller polls without an open management panel and consumers share one timer', async () => {
  const c = setup(), changes = []
  const unsubscribeDock = c.model.subscribe(() => changes.push('dock'))
  const unsubscribePanel = c.model.subscribe(() => changes.push('panel'))
  const stop = c.model.start()
  await flush()
  assert.deepEqual(c.calls, ['list', 'refresh:work'])
  assert.equal(c.model.getSnapshot().accounts[0].windows[0].usedPercent, 0)
  assert.equal(c.timers.size, 1)
  unsubscribePanel()
  await c.advance(ACCOUNT_USAGE_REFRESH_MS)
  assert.deepEqual(c.calls, ['list', 'refresh:work', 'list', 'refresh:work'])
  assert.ok(changes.includes('dock'))
  unsubscribeDock(); stop()
  assert.equal(c.timers.size, 0); assert.equal(c.visibility.size, 0)
})

test('hidden windows stop timers and resume with only one catch-up when due', async () => {
  const c = setup(), stop = c.model.start()
  await flush(); c.hide()
  assert.equal(c.timers.size, 0)
  await c.advance(ACCOUNT_USAGE_REFRESH_MS * 3)
  assert.equal(c.calls.length, 2)
  c.show(); c.show(); await flush()
  assert.deepEqual(c.calls, ['list', 'refresh:work', 'list', 'refresh:work'])
  assert.equal(c.timers.size, 1)
  stop()
})

test('initial hidden window loads stored DTO without querying providers until visible', async () => {
  const c = setup(); c.hide(); const stop = c.model.start(); await flush()
  assert.deepEqual(c.calls, ['list']); assert.equal(c.model.getSnapshot().loading, false)
  c.show(); await flush(); assert.deepEqual(c.calls, ['list', 'list', 'refresh:work'])
  stop()
})

test('StrictMode setup cleanup replay cancels first initial fetch', async () => {
  const c = setup(), cancel = c.model.start(); cancel()
  const stop = c.model.start(); await flush()
  assert.deepEqual(c.calls, ['list', 'refresh:work'])
  assert.equal(c.timers.size, 1); assert.equal(c.visibility.size, 1)
  stop()
})

test('late stopped responses cannot repopulate snapshots or notify consumers', async () => {
  const pending = deferred(), c = setup([], { accountsList: () => pending.promise })
  let notifications = 0; c.model.subscribe(() => notifications++)
  const stop = c.model.start(); await flush(); stop()
  const previous = notifications
  pending.resolve([account()]); await flush()
  assert.equal(notifications, previous); assert.equal(c.model.getSnapshot().accounts.length, 0)
  assert.equal(c.timers.size, 0)
})

test('queued removal follows refresh and a late result cannot resurrect removed account', async () => {
  const pending = deferred(), calls = []
  const c = setup([account()], { accountsRefresh: async () => { calls.push('refresh'); return pending.promise }, accountsRemove: async () => { calls.push('remove') } })
  const stop = c.model.start(); await flush()
  const removed = c.model.remove('work'); await flush()
  assert.deepEqual(calls, ['refresh'])
  pending.resolve(account({ status: 'ready', updatedAt: c.now() })); await flush()
  assert.equal(await removed, true); assert.deepEqual(calls, ['refresh', 'remove'])
  assert.deepEqual(c.model.getSnapshot().accounts, []); stop()
})

test('login clears old identity sample, serializes mutations and never triggers automatic login', async () => {
  const pending = deferred()
  const c = setup([account({ status: 'signed-out', identity: 'old@example.test' })], { accountsLogin: () => pending.promise })
  const stop = c.model.start(); await flush()
  assert.deepEqual(c.calls, ['list'])
  const login = c.model.login('work'); await flush()
  assert.equal(c.model.getSnapshot().busy, 'work')
  assert.equal(c.model.getSnapshot().accounts[0].status, 'signing-in')
  assert.equal(c.model.getSnapshot().accounts[0].identity, undefined)
  assert.deepEqual(c.model.getSnapshot().accounts[0].windows, [])
  assert.equal(await c.model.remove('work'), false)
  await c.advance(ACCOUNT_USAGE_REFRESH_MS * 2)
  assert.deepEqual(c.calls, ['list'])
  pending.resolve(account({ status: 'ready', updatedAt: c.now() })); await flush()
  assert.equal(await login, true); stop()
})

test('provider retry deadlines and unsupported/signed-out states are respected', async () => {
  const c = setup([
    account({ id: 'limit', status: 'rate-limited', retryAt: 1_800_000_000_000 + ACCOUNT_USAGE_REFRESH_MS * 2 }),
    account({ id: 'out', status: 'signed-out' }), account({ id: 'unsupported', status: 'unsupported' }),
    account({ id: 'auth', status: 'signing-in' })
  ])
  const stop = c.model.start(); await flush()
  assert.deepEqual(c.calls, ['list'])
  assert.equal(await c.model.refresh('limit'), false)
  await c.advance(ACCOUNT_USAGE_REFRESH_MS)
  assert.deepEqual(c.calls, ['list', 'list'])
  await c.advance(ACCOUNT_USAGE_REFRESH_MS)
  assert.deepEqual(c.calls, ['list', 'list', 'list', 'refresh:limit']); stop()
})

test('manual refresh is bounded by cache and unknown IPC failures never expose details', async () => {
  const c = setup([account({ status: 'error' })], { accountsRefresh: async () => { throw new Error('private /profiles/token=secret') } })
  const stop = c.model.start(); await flush()
  assert.match(c.model.getSnapshot().error, /No se pudo completar/)
  assert.ok(!c.model.getSnapshot().error.includes('secret'))
  assert.equal(await c.model.refresh('work'), false)
  c.model.clearError(); assert.equal(c.model.getSnapshot().error, '')
  assert.equal(await c.model.add({ provider: 'codex', label: 'Trabajo 2' }), true)
  assert.equal(c.model.getSnapshot().accounts.length, 2); stop()
})

test('sample/window age distinguishes unavailable, zero and expired windows', () => {
  const row = account({ status: 'ready', updatedAt: 1000 })
  assert.equal(quotaSampleIsStale(row, 1001), false)
  assert.equal(quotaSampleIsStale(row, 1000 + ACCOUNT_USAGE_REFRESH_MS), true)
  assert.equal(quotaSampleIsStale(account({ status: 'ready', updatedAt: undefined }), 1000), true)
  assert.equal(quotaWindowIsStale(row, { ...row.windows[0], resetsAt: 1002 }, 1002), true)
  assert.equal(quotaWindowIsStale(row, row.windows[0], 1001), false)
})

test('failed explicit login leaves no former identity quota and sanitized error', async () => {
  const c = setup([account({ status: 'signed-out', identity: 'old@example.test' })], { accountsLogin: async () => { throw new Error('secret authorization header') } })
  const stop = c.model.start(); await flush()
  assert.equal(await c.model.login('work'), false)
  const snapshot = c.model.getSnapshot()
  assert.equal(snapshot.accounts[0].status, 'signed-out')
  assert.equal(snapshot.accounts[0].identity, undefined)
  assert.deepEqual(snapshot.accounts[0].windows, [])
  assert.ok(!snapshot.error.includes('secret')); assert.equal(snapshot.busy, '')
  stop()
})

test('stopping cancels queued mutations and restarting waits for previous in-flight IPC', async () => {
  const pending = deferred(); let lists = 0
  const c = setup([account()], { accountsList: async () => { lists++; return lists === 1 ? pending.promise : [account({ status: 'signed-out' })] } })
  const stop = c.model.start(); await flush()
  const queued = c.model.add({ provider: 'codex', label: 'Canceled' }); await flush()
  stop(); const stopAgain = c.model.start(); await flush()
  assert.equal(lists, 1)
  pending.resolve([account()]); await flush()
  assert.equal(await queued, false)
  assert.ok(!c.calls.includes('add'))
  assert.equal(lists, 2)
  assert.equal(c.model.getSnapshot().accounts[0].status, 'signed-out')
  assert.equal(c.timers.size, 1)
  stopAgain()
})

test('one rejected account query does not starve later accounts in the same poll', async () => {
  const refreshes = []
  const c = setup([account(), account({ id: 'other', provider: 'codex' })], { accountsRefresh: async id => {
    refreshes.push(id)
    if (id === 'work') throw new Error('broken registry')
    return account({ id, provider: 'codex', status: 'ready', updatedAt: c.now() })
  } })
  const stop = c.model.start(); await flush()
  assert.deepEqual(refreshes, ['work', 'other'])
  assert.equal(c.model.getSnapshot().accounts[1].status, 'ready')
  assert.match(c.model.getSnapshot().error, /No se pudo completar/)
  await c.advance(ACCOUNT_USAGE_REFRESH_MS)
  assert.deepEqual(refreshes, ['work', 'other', 'work', 'other'])
  stop()
})

test('a fully successful later poll clears a previous list failure', async () => {
  let lists = 0
  const c = setup([], { accountsList: async () => {
    if (++lists === 1) throw new Error('temporary IPC failure')
    return []
  } })
  const stop = c.model.start(); await flush()
  assert.match(c.model.getSnapshot().error, /No se pudo completar/)
  await c.advance(ACCOUNT_USAGE_REFRESH_MS)
  assert.equal(lists, 2)
  assert.equal(c.model.getSnapshot().error, '')
  assert.equal(c.model.getSnapshot().busy, '')
  stop()
})

test('poll recovery clears old errors only when all eligible account queries succeed', async () => {
  let failing = true
  const c = setup([account(), account({ id: 'other' })], { accountsRefresh: async id => {
    if (id === 'work' && failing) throw new Error('temporary account IPC failure')
    return account({ id, status: 'ready', updatedAt: c.now() })
  } })
  const stop = c.model.start(); await flush()
  assert.match(c.model.getSnapshot().error, /No se pudo completar/)
  await c.advance(ACCOUNT_USAGE_REFRESH_MS)
  assert.match(c.model.getSnapshot().error, /No se pudo completar/)
  failing = false
  await c.advance(ACCOUNT_USAGE_REFRESH_MS)
  assert.equal(c.model.getSnapshot().error, '')
  stop()
})
