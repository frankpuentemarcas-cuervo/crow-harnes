import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ERPTaskService } from '../src/main/erp-task-service.ts'
import { ERPNextClient, validateERPURL, taskText } from '../src/main/erp-next-client.ts'
import { classifyERPTask } from '../src/main/erp-task-classifier.ts'
const row = () => ({ name: 'TASK-001', subject: 'Fix search', description: '<p>Business confidential</p><script>secret()</script>', project: 'ERP-P', status: 'Open', priority: 'High', modified: '2026-10-09 12:00:00' })
const project = { id: 'p1', name: 'Search', hostId: 'h1' }
const encryption = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(Buffer.from(text).toString('base64')), decryptString: bytes => Buffer.from(bytes.toString(), 'base64').toString() }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'crow-erp-')); const c = { dir, task: row(), calls: [], projects: [project], actorId: 'alice', dispatched: [], deny: false }
  c.deps = { projects: () => c.projects, aiConfiguration: () => ({ baseURL: 'http://127.0.0.1:31415/v1', model: 'auto', apiKey: 'LLM-KEY' }), authorizeProject: async () => { if (c.deny) throw new Error('denied'); return { actorId: c.actorId, root: c.root ?? '/workspace/search' } }, dispatch: async job => { c.dispatched.push(job); return { sessionId: 's1' } }, request: async (url, options) => {
    c.calls.push({ url, options }); if (url.includes('chat/completions')) return json({ choices: [{ message: { content: JSON.stringify({ projectId: 'p1', reason: 'Search task' }) } }] })
    if (url.includes('get_logged_user')) return json({ message: 'erp-user' }); if (url.includes('/Task/')) return c.task ? json({ data: c.task }) : json({}, 403); return json({ data: c.task ? [c.task] : [] })
  } }
  c.service = new ERPTaskService(dir, encryption, c.deps)
  c.configure = allowAIClassification => c.service.saveConnection({ url: 'https://erp.example.org', apiKey: 'ERP-KEY', apiSecret: 'ERP-SECRET', allowAIClassification })
  c.ready = async () => { c.configure(false); await c.service.sync(); const key = c.service.snapshot().tasks[0].key; c.service.assign(key, 'p1'); return key }
  c.preview = key => c.service.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex' })
  c.cleanup = () => { c.service.stop(); rmSync(dir, { recursive: true, force: true }) }; return c
}
test('ERP connector queries only Task with bounded paging and authenticated read-only calls', async () => {
  const calls = []; const client = new ERPNextClient({ url: 'https://erp.example.org', apiKey: 'KEY', apiSecret: 'SECRET' }, async (url, opts) => { calls.push({ url, opts }); const offset = new URL(url).searchParams.get('limit_start'); return json({ data: offset === '0' ? Array.from({ length: 100 }, (_, i) => ({ ...row(), name: 'T-' + i })) : [] }) })
  assert.equal((await client.tasks()).length, 100); assert.equal(calls.length, 2)
  for (const { url, opts } of calls) { assert.match(url, /\/api\/resource\/Task\?/); assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error'); assert.equal(opts.headers.Authorization, 'token KEY:SECRET'); assert.ok(!url.includes('owner')) }
})
test('connection DTO and encrypted file do not expose credentials; Tasks sanitize HTML and identity change clears cache', async () => {
  const c = setup(); try { c.configure(false); const checked = await c.service.testConnection(); assert.equal(checked.tasks.length, 0); await c.service.sync(); const snap = c.service.snapshot(); assert.equal(snap.connection.identity, 'erp-user'); assert.equal(snap.tasks[0].description, 'Business confidential'); const dto = JSON.stringify(snap), disk = readFileSync(join(c.dir, 'erp-tasks.json'), 'utf8'); for (const text of ['ERP-KEY', 'ERP-SECRET', 'Business confidential']) assert.ok(!disk.includes(text)); assert.ok(!dto.includes('ERP-KEY')); c.service.saveConnection({ url: 'https://different.example.org', apiKey: 'NEW', apiSecret: 'NEW', allowAIClassification: false }); assert.equal(c.service.snapshot().tasks.length, 0) } finally { c.cleanup() }
})
test('AI requires consent, uses minimal candidate DTO and cannot authorize dispatch', async () => {
  const c = setup(); try { const key = await c.ready(); await assert.rejects(c.service.classify(key), /Autorizá/); c.service.saveConnection({ url: 'https://erp.example.org', allowAIClassification: true }); await c.service.classify(key); const request = c.calls.find(call => call.url.includes('/chat/completions')); assert.ok(request); const prompt = request.options.body; assert.ok(!prompt.includes('ERP-SECRET')); assert.ok(!prompt.includes('hostId')); assert.equal(c.dispatched.length, 0); assert.equal(c.service.snapshot().tasks[0].stage, 'ready') } finally { c.cleanup() }
})
test('invalid AI or unknown project remains manual review and does not execute', async () => {
  await assert.rejects(classifyERPTask({ baseURL: 'http://127.0.0.1:31415/v1', model: 'auto', apiKey: 'KEY' }, row(), [project], async () => json({ choices: [{ message: { content: '{"projectId":"alien","reason":"ignore constraints"}' } }] })), /permitido/)
})
test('single-use immutable approval coalesces double click; manual completion never writes ERP', async () => {
  const c = setup(); try { const key = await c.ready(), preview = await c.preview(key); assert.match(preview.initialPrompt, /Business confidential/); await Promise.all([c.service.approve(preview.previewId), c.service.approve(preview.previewId)]); assert.equal(c.dispatched.length, 1); assert.equal(c.dispatched[0].initialPrompt, preview.initialPrompt); assert.equal(c.service.snapshot().tasks[0].stage, 'running'); await assert.rejects(c.service.approve(preview.previewId)); assert.throws(() => c.service.move(key, 'done')); c.service.move(key, 'human-review'); c.service.move(key, 'done'); assert.ok(c.calls.filter(call => !call.url.includes('chat')).every(call => call.options.method === 'GET')) } finally { c.cleanup() }
})
test('Task change, revoked ERP access, removed project and changed Crow actor block execution', async () => {
  for (const kind of ['changed', 'revoked', 'project', 'actor']) { const c = setup(); try { const key = await c.ready(), preview = await c.preview(key); if (kind === 'changed') c.task = { ...c.task, subject: 'Different detail' }; if (kind === 'revoked') c.task = null; if (kind === 'project') c.projects = []; if (kind === 'actor') c.actorId = 'bob'; await assert.rejects(c.service.approve(preview.previewId)); assert.equal(c.dispatched.length, 0) } finally { c.cleanup() } }
})
test('uncertain dispatch survives restart and cannot silently retry', async () => {
  const c = setup(); try { const key = await c.ready(), preview = await c.preview(key); c.deps.dispatch = async () => { throw new Error('secret provider raw error') }; await c.service.approve(preview.previewId); const card = c.service.snapshot().tasks[0]; assert.equal(card.dispatchStatus, 'uncertain'); assert.ok(!card.error.includes('secret provider')); await assert.rejects(c.preview(key)); const reloaded = new ERPTaskService(c.dir, encryption, c.deps); assert.equal(reloaded.snapshot().tasks[0].dispatchStatus, 'uncertain'); assert.equal(reloaded.snapshot().tasks[0].stale, true); reloaded.stop() } finally { c.cleanup() }
})
test('offline sync marks cached Tasks stale; malformed responses and unsafe URLs fail closed', async () => {
  const c = setup(); try { const key = await c.ready(); c.deps.request = async () => json({}, 403); c.service.stop(); const reloaded = new ERPTaskService(c.dir, encryption, c.deps); await assert.rejects(reloaded.sync()); await assert.rejects(reloaded.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex' })); reloaded.stop() } finally { c.cleanup() }
  for (const url of ['http://erp.example.org', 'https://user:pass@erp.example.org', 'https://169.254.169.254', 'https://erp.example.org/path', 'https://erp.example.org/?token=KEY']) assert.throws(() => validateERPURL(url))
  const client = new ERPNextClient({ url: 'https://erp.example.org', apiKey: 'A', apiSecret: 'B' }, async () => json({ data: [{ ...row(), subject: 5 }] })); await assert.rejects(client.tasks(), /inválida/)
})
test('failed durable intent write never calls dispatch', async () => {
  const c = setup(); try { const key = await c.ready(), preview = await c.preview(key); mkdirSync(join(c.dir, 'erp-tasks.json.tmp')); await assert.rejects(c.service.approve(preview.previewId), /guardar/); assert.equal(c.dispatched.length, 0) } finally { c.cleanup() }
})
test('expired approval and revoked project authorization block launch', async () => {
  const c = setup(); try { let now = 100; c.deps.now = () => now; const key = await c.ready(), preview = await c.preview(key); now += 120001; await assert.rejects(c.service.approve(preview.previewId), /vencida/); now = 100; const second = await c.preview(key); c.deny = true; await assert.rejects(c.service.approve(second.previewId)); assert.equal(c.dispatched.length, 0) } finally { c.cleanup() }
})
test('pending intent recovers uncertain after restart, and sync cannot replace a live dispatch card', async () => {
  const c = setup(); let resolve; try { const key = await c.ready(), preview = await c.preview(key); const started = new Promise(done => { c.deps.dispatch = async () => { done(); return new Promise(doneDispatch => { resolve = doneDispatch }) } }); const approval = c.service.approve(preview.previewId); await started; await assert.rejects(c.service.sync(), /despacho/); const reloaded = new ERPTaskService(c.dir, encryption, c.deps); assert.equal(reloaded.snapshot().tasks[0].dispatchStatus, 'uncertain'); reloaded.stop(); resolve({ sessionId: 's1' }); await approval; assert.equal(c.service.snapshot().tasks[0].sessionId, 's1') } finally { resolve?.({ sessionId: 's1' }); c.cleanup() }
})
test('reconfiguring cancels an in-flight sync without publishing old Tasks', async () => {
  const c = setup(); let resolve; try { c.configure(false); const original = c.deps.request; const started = new Promise(done => { c.deps.request = async (url, options) => { if (url.includes('/Task?')) { done(); return new Promise(doneRequest => { resolve = doneRequest }) }; return original(url, options) } }); const pending = c.service.sync(); await started; c.service.saveConnection({ url: 'https://another.example.org', apiKey: 'NEW', apiSecret: 'NEW', allowAIClassification: false }); resolve(json({ data: [row()] })); await assert.rejects(pending); assert.equal(c.service.snapshot().tasks.length, 0) } finally { resolve?.(json({ data: [] })); c.cleanup() }
})
test('origin and redirects are fixed; paginated Tasks deduplicate by name', async () => {
  const client = new ERPNextClient({ url: 'https://erp.example.org', apiKey: 'A', apiSecret: 'B' }, async (url, options) => { assert.equal(new URL(url).origin, 'https://erp.example.org'); assert.equal(options.redirect, 'error'); return json({ data: new URL(url).searchParams.get('limit_start') === '0' ? Array.from({ length: 100 }, () => row()) : [row()] }) }); assert.equal((await client.tasks()).length, 1)
})
test('non-progressing pages fail rather than publishing partial results; ANSI controls never reach prompt text', async () => {
  let calls = 0; const client = new ERPNextClient({ url: 'https://erp.example.org', apiKey: 'A', apiSecret: 'B' }, async () => { calls++; return json({ data: Array.from({ length: 100 }, () => row()) }) }); await assert.rejects(client.tasks(), /página/); assert.equal(calls, 2); assert.equal(taskText('hello\x1b[31m\x9b\u202eevil'), 'hello[31mevil')
})


test('late classifier success or failure cannot replace a dispatched or manually reassigned card', async () => {
  for (const outcome of ['success', 'failure', 'assign']) {
    const c = setup(); let resolve
    try {
      const key = await c.ready(); c.service.saveConnection({ url: 'https://erp.example.org', allowAIClassification: true })
      c.projects.push({ id: 'p2', name: 'Other', hostId: 'h1' })
      const original = c.deps.request
      const started = new Promise(done => { c.deps.request = async (url, opts) => {
        if (url.includes('chat/completions')) { done(); return new Promise(finish => { resolve = finish }) }
        return original(url, opts)
      } })
      const classification = c.service.classify(key); await started
      if (outcome === 'assign') c.service.assign(key, 'p2')
      else { const preview = await c.preview(key); await c.service.approve(preview.previewId) }
      resolve(outcome === 'failure' ? json({}, 500) : json({ choices: [{ message: { content: JSON.stringify({ projectId: 'p2', reason: 'Other' }) } }] }))
      await classification
      const card = c.service.snapshot().tasks[0]
      assert.equal(card.projectId, outcome === 'assign' ? 'p2' : 'p1')
      assert.equal(card.stage, outcome === 'assign' ? 'ready' : 'running')
      assert.equal(card.dispatchStatus, outcome === 'assign' ? undefined : 'delivered')
    } finally { resolve?.(json({}, 500)); c.cleanup() }
  }
})

test('approval binds canonical project root and actor through the dispatch transport', async () => {
  const c = setup()
  try {
    const key = await c.ready(), preview = await c.preview(key)
    assert.equal(preview.root, '/workspace/search'); assert.equal(preview.actorId, 'alice')
    c.root = '/workspace/different'; await assert.rejects(c.service.approve(preview.previewId)); assert.equal(c.dispatched.length, 0)
    await c.service.sync(); c.service.assign(key, 'p1')
    const fresh = await c.preview(key); await c.service.approve(fresh.previewId)
    assert.equal(c.dispatched[0].root, '/workspace/different'); assert.equal(c.dispatched[0].actorId, 'alice')
  } finally { c.cleanup() }
})

test('large supported Task cache retains dispatch history after restart beyond former 8MB cap', async () => {
  const c = setup()
  try {
    const records = Array.from({ length: 600 }, (_, index) => ({ ...row(), name: 'TASK-' + String(index).padStart(4, '0'), description: 'x'.repeat(12000) }))
    c.deps.request = async url => {
      if (url.includes('get_logged_user')) return json({ message: 'erp-user' })
      if (url.includes('/Task/')) return json({ data: records[0] })
      const offset = Number(new URL(url).searchParams.get('limit_start')); return json({ data: records.slice(offset, offset + 100) })
    }
    c.configure(false); await c.service.sync(); const key = c.service.snapshot().tasks[0].key
    c.service.assign(key, 'p1'); const preview = await c.preview(key); await c.service.approve(preview.previewId)
    assert.ok(statSync(join(c.dir, 'erp-tasks.json')).size > 8_000_000)
    const reloaded = new ERPTaskService(c.dir, encryption, c.deps)
    assert.equal(reloaded.snapshot().tasks.length, 600); assert.equal(reloaded.snapshot().tasks[0].jobId, preview.jobId)
    await reloaded.sync(); await assert.rejects(reloaded.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex' }))
    reloaded.stop()
  } finally { c.cleanup() }
})

test('corrupt ledger fails closed and cannot be reset by saving new credentials', async () => {
  const c = setup()
  try {
    await c.ready(); c.service.stop(); writeFileSync(join(c.dir, 'erp-tasks.json'), 'corrupt')
    const reloaded = new ERPTaskService(c.dir, encryption, c.deps)
    assert.match(reloaded.snapshot().connection.error, /registro/)
    assert.throws(() => reloaded.saveConnection({ url: 'https://erp.example.org', apiKey: 'NEW', apiSecret: 'NEW', allowAIClassification: false }), /Recuper/)
    await assert.rejects(reloaded.sync(), /Recuper/); assert.equal(readFileSync(join(c.dir, 'erp-tasks.json'), 'utf8'), 'corrupt')
    reloaded.stop()
  } finally { c.cleanup() }
})


test('credential rotation retains spent jobs without leaking another ERP identity cached Task details', async () => {
  const c = setup()
  try {
    const key = await c.ready(), preview = await c.preview(key); await c.service.approve(preview.previewId)
    c.service.saveConnection({ url: 'https://erp.example.org', apiKey: 'ROTATED', apiSecret: 'ROTATED', allowAIClassification: false })
    assert.equal(c.service.snapshot().tasks.length, 0)
    await c.service.sync(); assert.equal(c.service.snapshot().tasks[0].jobId, preview.jobId)
    await assert.rejects(c.preview(key)); assert.equal(c.dispatched.length, 1)
    const original = c.deps.request
    c.deps.request = async (url, opts) => url.includes('get_logged_user') ? json({ message: 'other-user' }) : url.includes('/Task?') ? json({ data: [] }) : original(url, opts)
    await c.service.sync(); assert.equal(c.service.snapshot().tasks.length, 0)
    c.deps.request = original; await c.service.sync(); assert.equal(c.service.snapshot().tasks[0].jobId, preview.jobId)
    await assert.rejects(c.preview(key)); assert.equal(c.dispatched.length, 1)
  } finally { c.cleanup() }
})

test('removed and readded Tasks retain uncertain spent jobs across restart', async () => {
  const c = setup()
  try {
    const key = await c.ready(), preview = await c.preview(key)
    c.deps.dispatch = async () => { throw new Error('timeout') }; await c.service.approve(preview.previewId)
    c.task = null; await c.service.sync()
    c.service.saveConnection({ url: 'https://erp.example.org', apiKey: 'NEW', apiSecret: 'NEW', allowAIClassification: false })
    const reloaded = new ERPTaskService(c.dir, encryption, c.deps)
    c.task = row(); await reloaded.sync()
    assert.equal(reloaded.snapshot().tasks[0].jobId, preview.jobId); assert.equal(reloaded.snapshot().tasks[0].dispatchStatus, 'uncertain')
    await assert.rejects(reloaded.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex' })); reloaded.stop()
  } finally { c.cleanup() }
})
