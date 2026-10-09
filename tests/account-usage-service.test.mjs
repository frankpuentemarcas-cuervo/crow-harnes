import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountUsageService } from '../src/main/account-usage-service.ts'

function setup(adapter = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crow-accounts-'))
  let now = 1_800_000_000_000, calls = 0
  const provider = { login: async () => {}, usage: async () => { calls++; return { identity: 'person@example.org', windows: [{ id: 'five_hour', label: '5 horas', usedPercent: 0 }] } }, ...adapter }
  const service = new AccountUsageService(dir, { claude: provider, codex: provider }, () => now)
  return { dir, service, provider, calls: () => calls, advance: ms => now += ms, cleanup: () => { service.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('global accounts are isolated, cache/coalesce and persist only allowed fields', async () => {
  const c = setup()
  try {
    const first = c.service.add({ provider: 'claude', label: 'Personal' })
    const second = c.service.add({ provider: 'claude', label: 'Trabajo' })
    assert.notEqual(first.id, second.id)
    assert.notEqual(c.service.profilePath(first.id), c.service.profilePath(second.id))
    await Promise.all([c.service.refresh(first.id), c.service.refresh(first.id)])
    assert.equal(c.calls(), 1)
    await c.service.refresh(first.id); assert.equal(c.calls(), 1)
    await c.service.refresh(second.id); assert.equal(c.calls(), 2)
    const reloaded = new AccountUsageService(c.dir, { claude: c.provider, codex: c.provider })
    assert.equal(reloaded.list().length, 2)
    const json = readFileSync(join(c.dir, 'accounts.json'), 'utf8')
    assert.ok(!json.includes('hostId')); assert.ok(!json.includes('profileDir'))
    assert.equal(first.status, 'signed-out')
    assert.equal(c.service.list()[0].windows[0].usedPercent, 0)
    reloaded.stop()
  } finally { c.cleanup() }
})

test('validation prevents traversal and malformed provider/label', () => {
  const c = setup()
  try {
    assert.throws(() => c.service.profilePath('../..'))
    assert.throws(() => c.service.add({ provider: 'other', label: 'x' }))
    assert.throws(() => c.service.add({ provider: 'codex', label: '  ' }))
    assert.throws(() => c.service.add(null))
    writeFileSync(join(c.dir, 'accounts.json'), JSON.stringify([{ id: '../../outside', provider: 'codex', label: 'x', accessToken: 'secret' }]))
    const reloaded = new AccountUsageService(c.dir, { claude: c.provider, codex: c.provider })
    assert.deepEqual(reloaded.list(), []); reloaded.stop()
  } finally { c.cleanup() }
})

test('transient failure preserves original sample timestamp; auth failure discards old account quota', async () => {
  const c = setup()
  try {
    const account = c.service.add({ provider: 'codex', label: 'Cuenta' })
    const sample = await c.service.refresh(account.id)
    c.advance(180001)
    c.provider.usage = async () => { throw new Error('secret-token private provider body') }
    const stale = await c.service.refresh(account.id)
    assert.equal(stale.status, 'stale'); assert.equal(stale.updatedAt, sample.updatedAt)
    assert.equal(stale.windows.length, 1); assert.ok(!stale.error.includes('secret-token'))
    c.advance(30001)
    c.provider.usage = async () => { throw Object.assign(new Error('raw'), { code: 'signed-out' }) }
    const invalid = await c.service.refresh(account.id)
    assert.equal(invalid.status, 'signed-out'); assert.deepEqual(invalid.windows, []); assert.equal(invalid.identity, undefined)
  } finally { c.cleanup() }
})

test('429 backoff cannot be bypassed by manual refresh', async () => {
  let calls = 0
  const c = setup({ usage: async () => { calls++; throw Object.assign(new Error('raw'), { code: 'rate-limited', retryAt: 1_800_000_120_000 }) } })
  try {
    const account = c.service.add({ provider: 'codex', label: 'Cuota' })
    assert.equal((await c.service.refresh(account.id)).status, 'rate-limited')
    await c.service.refresh(account.id); assert.equal(calls, 1)
    c.advance(120001); await c.service.refresh(account.id); assert.equal(calls, 2)
  } finally { c.cleanup() }
})

test('login invalidates old samples and remove does not resurrect in-flight accounts', async () => {
  let complete
  const c = setup()
  try {
    const account = c.service.add({ provider: 'claude', label: 'Cuenta' })
    await c.service.refresh(account.id)
    c.provider.login = () => new Promise(resolve => { complete = resolve })
    const pending = c.service.login(account.id)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(c.service.list()[0].status, 'signing-in')
    assert.deepEqual(c.service.list()[0].windows, [])
    await c.service.remove(account.id)
    complete(); await pending
    assert.deepEqual(c.service.list(), [])
    for (let i = 0; i < 30 && existsSync(join(c.dir, 'account-profiles', account.id)); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(existsSync(join(c.dir, 'account-profiles', account.id)), false)
  } finally { c.cleanup() }
})

test('invalid quota or malicious extra fields never leak to public DTO/storage', async () => {
  const c = setup({ usage: async () => ({ identity: 'ok@example.org', accessToken: 'SECRET', windows: [{ id: 'window', label: 'Cuota', usedPercent: 100, token: 'SECRET' }] }) })
  try {
    const account = c.service.add({ provider: 'claude', label: 'Cuenta' })
    const result = await c.service.refresh(account.id)
    assert.equal(result.windows[0].usedPercent, 100)
    assert.ok(!JSON.stringify(result).includes('SECRET'))
    c.advance(180001); c.provider.usage = async () => ({ windows: [{ id: 'bad', label: 'bad', usedPercent: 101 }] })
    assert.equal((await c.service.refresh(account.id)).status, 'stale')
  } finally { c.cleanup() }
})

test('global concurrency is bounded and stopping skips queued requests', async () => {
  let active = 0, maxActive = 0, calls = 0
  const completions = []
  const c = setup({ usage: async () => {
    calls++; active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => completions.push(resolve))
    active--
    return { windows: [{ id: 'quota', label: 'Cuota', usedPercent: 50 }] }
  } })
  try {
    const accounts = Array.from({ length: 4 }, (_, i) => c.service.add({ provider: 'codex', label: `Cuenta ${i}` }))
    const pending = accounts.map(a => c.service.refresh(a.id))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 2); assert.equal(maxActive, 2)
    c.service.stop()
    for (const complete of completions) complete()
    await Promise.all(pending)
    assert.equal(calls, 2)
    assert.equal(c.service.list().filter(a => a.status === 'ready').length, 0)
    await assert.rejects(c.service.refresh(accounts[0].id))
  } finally { c.cleanup() }
})

test('prototype error codes cannot escape the public status allowlist', async () => {
  const c = setup({ usage: async () => { throw { code: '__proto__', secret: 'TOKEN' } } })
  try {
    const account = c.service.add({ provider: 'claude', label: 'Cuenta' })
    assert.equal((await c.service.refresh(account.id)).status, 'error')
    assert.ok(!readFileSync(join(c.dir, 'accounts.json'), 'utf8').includes('TOKEN'))
  } finally { c.cleanup() }
})

test('persistence failures are sanitized and failed add/remove roll back the registry', async () => {
  const c = setup()
  try {
    const first = c.service.add({ provider: 'codex', label: 'Cuenta' })
    // Force rename failure deterministically without depending on platform permissions.
    rmSync(join(c.dir, 'accounts.json'))
    mkdirSync(join(c.dir, 'accounts.json'))
    assert.throws(() => c.service.add({ provider: 'claude', label: 'Otra' }), error => !error.message.includes(c.dir) && !error.message.includes('EPERM') && !error.message.includes('EISDIR'))
    assert.equal(c.service.list().length, 1)
    await assert.rejects(c.service.remove(first.id), error => !error.message.includes(c.dir))
    assert.equal(c.service.list()[0].id, first.id)
    assert.equal(existsSync(c.service.profilePath(first.id)), true)
    assert.throws(() => c.service.login(first.id), error => !error.message.includes(c.dir))
    assert.equal(c.service.list()[0].status, 'signed-out')
    rmSync(join(c.dir, 'accounts.json'), { recursive: true })
    // Failure did not leave a pending operation/locked signing-in state.
    assert.equal((await c.service.login(first.id)).status, 'ready')
  } finally { c.cleanup() }
})

test('provider rate-limit backoff survives a registry restart', async () => {
  const c = setup({ usage: async () => { throw Object.assign(new Error('raw'), { code: 'rate-limited', retryAt: Date.now() + 600000 }) } })
  try {
    const first = c.service.add({ provider: 'claude', label: 'Cuenta' })
    await c.service.refresh(first.id)
    let calls = 0
    const provider = { login: async () => {}, usage: async () => { calls++; return { windows: [] } } }
    const service = new AccountUsageService(c.dir, { codex: provider, claude: provider }, () => 1_800_000_000_000)
    await service.refresh(first.id)
    assert.equal(calls, 0); assert.equal(service.list()[0].status, 'rate-limited')
    service.stop()
  } finally { c.cleanup() }
})
