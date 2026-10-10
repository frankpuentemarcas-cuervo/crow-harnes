import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ERPNextClient } from '../src/main/erp-next-client.ts'
import { ERPTaskService } from '../src/main/erp-task-service.ts'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const row = index => ({ name: `TASK-${index}`, subject: 'Test task', description: 'Fictitious', project: '', status: 'Open', priority: 'Low', modified: '2026-10-10 12:00:00' })
const credentials = { url: 'https://erp.example.org', apiKey: 'TEST-KEY', apiSecret: 'TEST-SECRET' }
const encryption = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(Buffer.from(value).toString('base64')), decryptString: value => Buffer.from(value.toString(), 'base64').toString() }
function serviceFixture(request) {
  const dir = mkdtempSync(join(tmpdir(), 'crow-erp-pagination-'))
  const service = new ERPTaskService(dir, encryption, {
    projects: () => [], aiConfiguration: () => { throw new Error('Must not consult AI') },
    authorizeProject: async () => { throw new Error('Must not authorize dispatch') },
    dispatch: async () => { throw new Error('Must not start a terminal') }, request
  })
  service.saveConnection({ ...credentials, allowAIClassification: false })
  return { service, cleanup() { service.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('connection check validates identity and one name, without importing the Task catalogue', async () => {
  const calls = []
  const fixture = serviceFixture(async (url, options) => {
    const query = new URL(url); calls.push(query)
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'token TEST-KEY:TEST-SECRET')
    if (query.pathname.includes('get_logged_user')) return json({ message: 'test-user' })
    assert.equal(query.pathname, '/api/resource/Task')
    assert.equal(query.searchParams.get('limit_page_length'), '1')
    assert.deepEqual(JSON.parse(query.searchParams.get('fields')), ['name'])
    return json({ data: [{ name: 'TASK-1' }] })
  })
  try {
    const result = await fixture.service.testConnection()
    assert.equal(calls.length, 2); assert.equal(result.connection.identity, 'test-user')
    assert.equal(result.tasks.length, 0)
  } finally { fixture.cleanup() }
})

test('empty Task permissions scope is still a successful connection check', async () => {
  const fixture = serviceFixture(async url => json(url.includes('get_logged_user') ? { message: 'test-user' } : { data: [] }))
  try { assert.equal((await fixture.service.testConnection()).connection.identity, 'test-user') } finally { fixture.cleanup() }
})

test('checking a connection never turns stale cached Tasks into fresh executable Tasks', async () => {
  let allowed = true
  const fixture = serviceFixture(async url => url.includes('get_logged_user') ? json({ message: 'test-user' }) : allowed ? json({ data: [row(1)] }) : json({}, 403))
  try {
    await fixture.service.sync(); allowed = false
    await assert.rejects(fixture.service.sync()); allowed = true
    const result = await fixture.service.testConnection()
    assert.equal(result.tasks.length, 1); assert.equal(result.tasks[0].stale, true)
    assert.equal(result.tasks[0].description, 'Fictitious')
  } finally { fixture.cleanup() }
})

test('connection check rejects Task permission failure and invalidates cached Tasks', async () => {
  let allowed = true
  const fixture = serviceFixture(async url => url.includes('get_logged_user') ? json({ message: 'test-user' }) : allowed ? json({ data: [row(1)] }) : json({}, 403))
  try {
    await fixture.service.sync(); allowed = false
    await assert.rejects(fixture.service.testConnection(), /credenciales o permisos/)
    assert.equal(fixture.service.snapshot().tasks[0].stale, true)
  } finally { fixture.cleanup() }
})

test('checking a different ERP identity cannot expose the previous account catalogue', async () => {
  let identity = 'first-user'
  const fixture = serviceFixture(async url => json(url.includes('get_logged_user') ? { message: identity } : { data: [row(1)] }))
  try {
    await fixture.service.sync(); identity = 'second-user'
    const result = await fixture.service.testConnection()
    assert.equal(result.connection.identity, 'second-user'); assert.equal(result.tasks.length, 0)
  } finally { fixture.cleanup() }
})

test('credential changes during a check discard late identity and permission results', async () => {
  let finish
  const fixture = serviceFixture(async url => url.includes('get_logged_user') ? json({ message: 'first-user' }) : new Promise(resolve => { finish = resolve }))
  try {
    const check = fixture.service.testConnection()
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    fixture.service.saveConnection({ url: 'https://another.example.org', apiKey: 'OTHER', apiSecret: 'OTHER', allowAIClassification: false })
    finish(json({ data: [{ name: 'TASK-1' }] })); await assert.rejects(check)
    assert.equal(fixture.service.snapshot().connection.identity, undefined)
    assert.equal(fixture.service.snapshot().connection.url, 'https://another.example.org')
  } finally { finish?.(json({ data: [] })); fixture.cleanup() }
})

test('concurrent reads do not race connection checks and full synchronizations', async () => {
  const finishes = []
  const fixture = serviceFixture(async url => url.includes('get_logged_user') ? json({ message: 'test-user' }) : new Promise(resolve => { finishes.push(resolve) }))
  try {
    const check = fixture.service.testConnection()
    while (!finishes.length) await new Promise(resolve => setImmediate(resolve))
    const assertion = assert.rejects(fixture.service.sync(), /consulta|sincroniz/i)
    await new Promise(resolve => setImmediate(resolve))
    finishes.forEach(finish => finish(json({ data: [] })))
    await assertion; await check
  } finally { finishes.forEach(finish => finish(json({ data: [] }))); fixture.cleanup() }
})

for (const total of [2000, 2001, 2501]) test(`complete pagination loads ${total} Tasks and proves the last page`, async () => {
  const records = Array.from({ length: total }, (_, index) => row(index)), offsets = []
  const client = new ERPNextClient(credentials, async (url, options) => {
    assert.equal(options.method, 'GET')
    const offset = Number(new URL(url).searchParams.get('limit_start')); offsets.push(offset)
    return json({ data: records.slice(offset, offset + 100) })
  })
  assert.equal((await client.tasks()).length, total)
  assert.equal(offsets.at(-1), Math.floor(total / 100) * 100)
})

test('an upstream repeating full pages fails promptly rather than looping forever', async () => {
  let calls = 0
  const client = new ERPNextClient(credentials, async () => { calls++; return json({ data: Array.from({ length: 100 }, (_, index) => row(index)) }) })
  await assert.rejects(client.tasks(), /página|avance/i); assert.equal(calls, 2)
})

test('aggregate transfer budget bounds large catalogues without exposing a partial result', async () => {
  let calls = 0
  const client = new ERPNextClient(credentials, async url => {
    calls++; const offset = Number(new URL(url).searchParams.get('limit_start'))
    return json({ data: Array.from({ length: 100 }, (_, index) => ({ ...row(offset + index), description: 'x'.repeat(18000) })) })
  })
  await assert.rejects(client.tasks(), /límite|datos/i)
  assert.ok(calls < 25, `Too many reads: ${calls}`)
})

test('an incomplete large refresh cannot replace a previously verified catalogue', async () => {
  let failLate = false
  const fixture = serviceFixture(async url => {
    if (url.includes('get_logged_user')) return json({ message: 'test-user' })
    if (!failLate) return json({ data: [row('original')] })
    const offset = Number(new URL(url).searchParams.get('limit_start'))
    if (offset === 2100) return json({}, 403)
    return json({ data: Array.from({ length: 100 }, (_, index) => row(offset + index)) })
  })
  try {
    await fixture.service.sync(); failLate = true
    await assert.rejects(fixture.service.sync(), /credenciales o permisos/)
    const result = fixture.service.snapshot()
    assert.equal(result.tasks.length, 1); assert.equal(result.tasks[0].name, 'TASK-original')
    assert.equal(result.tasks[0].stale, true)
  } finally { fixture.cleanup() }
})

test('catalogue pagination stops on cancellation even if a request mock ignores its signal', async () => {
  const cancel = new AbortController(); let calls = 0
  const client = new ERPNextClient(credentials, async url => {
    calls++; const offset = Number(new URL(url).searchParams.get('limit_start'))
    if (offset === 100) cancel.abort()
    return json({ data: Array.from({ length: 100 }, (_, index) => row(offset + index)) })
  }, cancel.signal)
  await assert.rejects(client.tasks(), /cancelada/); assert.equal(calls, 2)
})

test('the overall catalogue deadline reaches requests and releases the pending read', async context => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  context.mock.method(AbortSignal, 'timeout', duration => timeout(duration === 120000 ? 5 : duration))
  let calls = 0
  const client = new ERPNextClient(credentials, async (_url, options) => {
    calls++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(json({ data: [] })), 100)
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason) }, { once: true })
    })
  })
  await assert.rejects(client.tasks(), /No se pudo|tiempo/); assert.equal(calls, 1)
})

test('malformed permission responses cannot mark a connection verified', async () => {
  const fixture = serviceFixture(async url => json(url.includes('get_logged_user') ? { message: 'test-user' } : { data: [{ name: 123 }] }))
  try {
    await assert.rejects(fixture.service.testConnection(), /acceso/)
    assert.equal(fixture.service.snapshot().connection.identity, undefined)
  } finally { fixture.cleanup() }
})
