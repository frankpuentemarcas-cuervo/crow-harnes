import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ERPTaskService } from '../src/main/erp-task-service.ts'
import { ERPNextClient, validateERPURL, taskText } from '../src/main/erp-next-client.ts'
import { classifyERPTask } from '../src/main/erp-task-classifier.ts'
const row = () => ({ name: 'TASK-001', subject: 'Fix search', description: '<p>Business confidential</p><script>secret()</script>', project: 'ERP-P', status: 'Open', priority: 'High', modified: '2026-10-09 12:00:00', _assign: '["carlospalacios@larael.com"]' })
const project = { id: 'p1', name: 'Search', hostId: 'h1', summary: 'Buscador de personal', tags: ['rrhh', 'busqueda'], repository: 'gitlab.com/company/search' }
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
  for (const { url, opts } of calls) { assert.match(url, /\/api\/resource\/Task\?/); assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error'); assert.equal(opts.headers.Authorization, 'token KEY:SECRET'); const query = new URL(url).searchParams; assert.ok(!url.includes('owner')); assert.ok(JSON.parse(query.get('fields')).includes('_assign')); assert.deepEqual(JSON.parse(query.get('filters')), [['status', '=', 'Open'], ['_assign', 'like', '%carlospalacios@larael.com%']]) }
})
test('Kanban includes only exact _assign membership and never substring matches another address', async () => {
  const rows = [row(), { ...row(), name: 'TASK-OTHER-1', _assign: '["other@larael.com"]' }, { ...row(), name: 'TASK-OTHER-2', _assign: '["carlospalacios@larael.com.evil"]' }, { ...row(), name: 'TASK-MALFORMED', _assign: 'not-json' }]
  const client = new ERPNextClient({ url: 'https://erp.example.org', apiKey: 'KEY', apiSecret: 'SECRET' }, async () => json({ data: rows }))
  await assert.rejects(client.tasks(), /Task inválida/)
  const validRows = rows.slice(0, 3)
  const validClient = new ERPNextClient({ url: 'https://erp.example.org', apiKey: 'KEY', apiSecret: 'SECRET' }, async () => json({ data: validRows }))
  assert.deepEqual((await validClient.tasks()).map(task => task.name), ['TASK-001'])
})
test('connection DTO and encrypted file do not expose credentials; Tasks sanitize HTML and identity change clears cache', async () => {
  const c = setup(); try { c.configure(false); const checked = await c.service.testConnection(); assert.equal(checked.tasks.length, 0); await c.service.sync(); assert.equal(c.service.snapshot().tasks[0].description, ''); const snap = await c.service.loadDetail(c.service.snapshot().tasks[0].key); assert.equal(snap.connection.identity, 'erp-user'); assert.equal(snap.tasks[0].description, 'Business confidential'); const dto = JSON.stringify(snap), disk = readFileSync(join(c.dir, 'erp-tasks.json'), 'utf8'); for (const text of ['ERP-KEY', 'ERP-SECRET', 'Business confidential']) assert.ok(!disk.includes(text)); assert.ok(!dto.includes('ERP-KEY')); const ledger = JSON.parse(encryption.decryptString(Buffer.from(disk, 'base64'))); assert.equal(ledger.tasks[0].description, ''); c.service.saveConnection({ url: 'https://different.example.org', apiKey: 'NEW', apiSecret: 'NEW', allowAIClassification: false }); assert.equal(c.service.snapshot().tasks.length, 0) } finally { c.cleanup() }
})
test('old cached Tasks without verified assignee are hidden until an authoritative sync', async () => {
  const c = setup()
  try {
    await c.ready(); c.service.stop()
    const path = join(c.dir, 'erp-tasks.json')
    const ledger = JSON.parse(encryption.decryptString(Buffer.from(readFileSync(path, 'utf8'), 'base64')))
    delete ledger.tasks[0].assignedTo
    writeFileSync(path, encryption.encryptString(JSON.stringify(ledger)).toString('base64'))
    const reloaded = new ERPTaskService(c.dir, encryption, c.deps)
    assert.deepEqual(reloaded.snapshot().tasks, [])
    await reloaded.sync()
    assert.equal(reloaded.snapshot().tasks.length, 1)
    reloaded.stop()
  } finally { c.cleanup() }
})
test('AI uses only project names until separate project-context consent is granted', async () => {
  const c = setup(); try { const key = await c.ready(); await assert.rejects(c.service.classify(key), /Autorizá/); c.service.saveConnection({ url: 'https://erp.example.org', allowAIClassification: true }); await c.service.classify(key); const request = c.calls.find(call => call.url.includes('/chat/completions')); assert.ok(request); const prompt = request.options.body; assert.ok(!prompt.includes('ERP-SECRET')); assert.ok(!prompt.includes('hostId')); assert.ok(!prompt.includes('Buscador de personal')); assert.ok(!prompt.includes('gitlab.com/company/search')); c.calls.length = 0; c.service.saveConnection({ url: 'https://erp.example.org', allowAIClassification: true, allowProjectContext: true }); await c.service.classify(key); const contextualPrompt = c.calls.find(call => call.url.includes('/chat/completions')).options.body; assert.match(contextualPrompt, /Buscador de personal/); assert.match(contextualPrompt, /gitlab\.com\/company\/search/); assert.equal(c.dispatched.length, 0); assert.equal(c.service.snapshot().tasks[0].stage, 'ready') } finally { c.cleanup() }
})
test('GitLab README reaches Free LLM only as an explicit per-classification context', async () => {
  const c = setup()
  try {
    const key = await c.ready(); c.service.saveConnection({ url: 'https://erp.example.org', allowAIClassification: true })
    const context = [{ projectId: 'p1', fileName: 'src/search.ts', content: 'export class RecruitingSearch {}' }]
    await c.service.classify(key)
    assert.ok(!c.calls.find(call => call.url.includes('/chat/completions')).options.body.includes('RecruitingSearch'))
    c.calls.length = 0; c.projects = [{ ...project, repositoryReadable: true }]
    await c.service.classify(key, context)
    assert.match(c.calls.find(call => call.url.includes('/chat/completions')).options.body, /RecruitingSearch/)
    c.calls.length = 0; c.projects = [project]
    await assert.rejects(c.service.classify(key, context), /no están autorizados/)
    assert.equal(c.calls.some(call => call.url.includes('/chat/completions')), false)
  } finally { c.cleanup() }
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

test('lightweight Task cache omits descriptions and retains dispatch history after restart', async () => {
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
    assert.ok(statSync(join(c.dir, 'erp-tasks.json')).size < 1_000_000)
    // Import the former large encrypted format without losing spent-job safety.
    const legacy = JSON.parse(encryption.decryptString(Buffer.from(readFileSync(join(c.dir, 'erp-tasks.json'), 'utf8'), 'base64')))
    legacy.tasks.forEach(card => { card.description = 'x'.repeat(12000); delete card.descriptionLoaded })
    writeFileSync(join(c.dir, 'erp-tasks.json'), encryption.encryptString(JSON.stringify(legacy)).toString('base64'))
    assert.ok(statSync(join(c.dir, 'erp-tasks.json')).size > 8_000_000)
    const reloaded = new ERPTaskService(c.dir, encryption, c.deps)
    assert.equal(reloaded.snapshot().tasks.length, 600); assert.equal(reloaded.snapshot().tasks[0].jobId, preview.jobId)
    assert.ok(reloaded.snapshot().tasks.every(card => card.description === '' && card.descriptionLoaded === false))
    await reloaded.sync(); await assert.rejects(reloaded.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex' }))
    reloaded.stop()
  } finally { c.cleanup() }
})

test('detail is read on demand before classification and preview, never for catalogue sync', async () => {
  const c = setup()
  try {
    const key = await c.ready(); assert.ok(!c.calls.some(call => call.url.includes('/Task/')))
    const preview = await c.preview(key); assert.match(preview.initialPrompt, /Business confidential/)
    assert.equal(c.service.snapshot().tasks[0].descriptionLoaded, true)
    await c.service.sync(); c.service.assign(key, 'p1')
    c.service.saveConnection({ url: 'https://erp.example.org', allowAIClassification: true })
    await c.service.classify(key)
    assert.match(c.calls.find(call => call.url.includes('chat/completions')).options.body, /Business confidential/)
  } finally { c.cleanup() }
})

test('changed, closed, mismatched or inaccessible Task detail blocks classification and dispatch', async () => {
  for (const kind of ['changed', 'closed', 'mismatched', 'denied']) {
    const c = setup()
    try {
      const key = await c.ready()
      if (kind === 'changed') c.task.modified = '2026-10-11 12:00:00'
      if (kind === 'closed') c.task.status = 'Completed'
      if (kind === 'mismatched') c.task.name = 'OTHER-TASK'
      if (kind === 'denied') c.task = null
      await assert.rejects(c.preview(key)); assert.equal(c.dispatched.length, 0)
      assert.equal(c.service.snapshot().tasks[0].stale, true)
      assert.equal(c.service.snapshot().tasks[0].description, '')
    } finally { c.cleanup() }
  }
})

test('late detail cannot restore old credentials or leak another identity', async () => {
  const c = setup(); let release
  try {
    const key = await c.ready(), original = c.deps.request
    c.deps.request = async (url, opts) => url.includes('/Task/') ? new Promise(resolve => { release = resolve }) : original(url, opts)
    const detail = c.service.loadDetail(key)
    while (!release) await new Promise(resolve => setImmediate(resolve))
    c.service.saveConnection({ url: 'https://another.example.org', apiKey: 'NEW', apiSecret: 'NEW', allowAIClassification: false })
    release(json({ data: row() })); await assert.rejects(detail)
    assert.equal(c.service.snapshot().tasks.length, 0)
    await c.service.sync(); const newKey = c.service.snapshot().tasks[0].key
    c.deps.request = async (url, opts) => url.includes('get_logged_user') ? json({ message: 'other-user' }) : original(url, opts)
    await assert.rejects(c.service.loadDetail(newKey), /identidad/)
    assert.equal(c.service.snapshot().tasks.length, 0)
  } finally { release?.(json({ data: row() })); c.cleanup() }
})

test('detail locks concurrent reads and assignment, and a description-only change invalidates approval', async () => {
  const c = setup(); let release
  try {
    const key = await c.ready(), original = c.deps.request
    c.deps.request = async (url, opts) => url.includes('/Task/') ? new Promise(resolve => { release = resolve }) : original(url, opts)
    const detail = c.service.loadDetail(key)
    while (!release) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(c.service.sync(), /consulta/); await assert.rejects(c.service.testConnection(), /consulta/)
    assert.throws(() => c.service.assign(key, 'p1'), /consulta/)
    release(json({ data: row() })); await detail; c.deps.request = original
    const preview = await c.preview(key); c.task.description = 'Changed after preview'
    await assert.rejects(c.service.approve(preview.previewId), /cambió/); assert.equal(c.dispatched.length, 0)
  } finally { release?.(json({ data: row() })); c.cleanup() }
})

test('failed credential persistence keeps the previous saved connection and partial key pairs are rejected', async () => {
  const c = setup()
  try {
    await c.ready(); const before = c.service.snapshot()
    assert.throws(() => c.service.saveConnection({ url: 'https://erp.example.org', apiKey: 'NEW', allowAIClassification: false }), /ambas/)
    mkdirSync(join(c.dir, 'erp-tasks.json.tmp'))
    assert.throws(() => c.service.saveConnection({ url: 'https://other.example.org', apiKey: 'NEW', apiSecret: 'NEW', allowAIClassification: false }), /guardar/)
    assert.deepEqual(c.service.snapshot(), before)
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

// Existing-terminal association and submission are separate operations.
function terminalSetup(c) {
  c.terminals = [{ sessionId: 's-existing', projectId: 'p1', hostId: 'h1', name: 'Custom search', agent: 'codex' }]
  c.deps.terminals = async () => c.terminals
  c.deps.submit = async job => { c.dispatched.push(job); return { sessionId: job.sessionId, status: 'written' } }
  c.deps.submissionStatus = async () => ({ status: c.receipt ?? 'written' })
  return c
}
test('existing terminal link is metadata only, survives restart/sync and preserves custom name', async () => {
  const c = terminalSetup(setup()); try {
    const key = await c.ready()
    await c.service.assignTerminal(key, { projectId: 'p1', hostId: 'h1', sessionId: 's-existing' })
    const card = c.service.snapshot().tasks[0]
    assert.equal(card.sessionId, 's-existing'); assert.equal(card.sessionName, 'Custom search'); assert.equal(card.stage, 'ready'); assert.equal(card.jobId, undefined); assert.equal(c.dispatched.length, 0)
    const reloaded = new ERPTaskService(c.dir, encryption, c.deps); await reloaded.sync()
    assert.equal(reloaded.snapshot().tasks[0].sessionName, 'Custom search'); assert.equal(reloaded.snapshot().tasks[0].sessionId, 's-existing'); reloaded.stop()
  } finally { c.cleanup() }
})
test('existing terminal requires preview confirmation, coalesces approval and only hook acceptance marks running', async () => {
  const c = terminalSetup(setup()); try {
    const key = await c.ready(), preview = await c.service.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex', sessionId: 's-existing' })
    assert.equal(c.dispatched.length, 0)
    await Promise.all([c.service.approve(preview.previewId), c.service.approve(preview.previewId)])
    assert.equal(c.dispatched.length, 1); assert.equal(c.dispatched[0].sessionId, 's-existing'); assert.equal(c.dispatched[0].initialPrompt, preview.initialPrompt)
    let card = c.service.snapshot().tasks[0]; assert.equal(card.dispatchStatus, 'uncertain'); assert.equal(card.stage, 'human-review')
    c.terminals.push({ ...c.terminals[0], sessionId: 's-new-link', name: 'Other custom' })
    await c.service.assignTerminal(key, { projectId: 'p1', hostId: 'h1', sessionId: 's-new-link' })
    await c.service.sync(); card = c.service.snapshot().tasks[0]
    assert.equal(card.sessionId, 's-new-link'); assert.equal(card.dispatchTarget.sessionId, 's-existing'); assert.equal(card.dispatchStatus, 'uncertain')
    await assert.rejects(c.service.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex', sessionId: 's-new-link' }))
    c.receipt = 'accepted'; await c.service.reconcile(key); card = c.service.snapshot().tasks[0]
    assert.equal(card.dispatchStatus, 'delivered'); assert.equal(card.stage, 'running'); assert.equal(card.sessionId, 's-new-link'); assert.equal(c.dispatched.length, 1)
    const reloaded = new ERPTaskService(c.dir, encryption, c.deps); await reloaded.sync(); assert.equal(reloaded.snapshot().tasks[0].dispatchTarget.sessionId, 's-existing'); assert.equal(reloaded.snapshot().tasks[0].sessionId, 's-new-link'); reloaded.stop()
  } finally { c.cleanup() }
})
test('missing/foreign/stale terminal and changed target at confirmation never submit', async () => {
  const c = terminalSetup(setup()); try {
    const key = await c.ready()
    await assert.rejects(c.service.assignTerminal(key, { projectId: 'p1', hostId: 'wrong', sessionId: 's-existing' }))
    await assert.rejects(c.service.assignTerminal(key, { projectId: 'p1', hostId: 'h1', sessionId: 'missing' }))
    const preview = await c.service.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex', sessionId: 's-existing' }); c.terminals = []
    await assert.rejects(c.service.approve(preview.previewId)); assert.equal(c.dispatched.length, 0)
  } finally { c.cleanup() }
})
test('link persist failure rolls back selection; pending submission blocks reassignment', async () => {
  const c = terminalSetup(setup()); try {
    const key = await c.ready(); mkdirSync(join(c.dir, 'erp-tasks.json.tmp'))
    await assert.rejects(c.service.assignTerminal(key, { projectId: 'p1', hostId: 'h1', sessionId: 's-existing' }), /guardar/)
    assert.equal(c.service.snapshot().tasks[0].sessionId, undefined)
    rmSync(join(c.dir, 'erp-tasks.json.tmp'), { recursive: true })
    const preview = await c.service.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex', sessionId: 's-existing' })
    let release; c.deps.submit = async job => { await new Promise(resolve => { release = resolve }); return { sessionId: job.sessionId, status: 'accepted' } }
    const pending = c.service.approve(preview.previewId); while (!release) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(c.service.assignTerminal(key, { projectId: 'p1', hostId: 'h1', sessionId: 's-existing' }), /pendiente/); release(); await pending
  } finally { c.cleanup() }
})
test('existing-terminal preview validates UTF8 bytes before intent without truncating new-terminal detail', async () => {
  const c = terminalSetup(setup()); try {
    const key = await c.ready(); await c.service.loadDetail(key)
    let preview = await c.preview(key), overhead = Buffer.byteLength(preview.initialPrompt) - Buffer.byteLength('Business confidential')
    // A non-ASCII detail tests bytes rather than UTF16 character count.
    c.service.cards.get(key).description = 'é'.repeat(Math.floor((4096-overhead)/2)) + ('x'.repeat((4096-overhead)%2))
    const input = { taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex', sessionId: 's-existing' }
    preview = await c.service.preview(input); assert.equal(Buffer.byteLength(preview.initialPrompt), 4096)
    c.service.cards.get(key).description += 'é'
    await assert.rejects(c.service.preview(input), /4096 bytes/); assert.equal(c.service.snapshot().tasks[0].jobId, undefined)
    assert.ok(Buffer.byteLength((await c.preview(key)).initialPrompt) > 4096)
    c.service.cards.get(key).description = 'invalid\u0001control'
    await assert.rejects(c.service.preview(input), /control/); assert.equal(c.dispatched.length, 0)
  } finally { c.cleanup() }
})
test('fresh review-stage Task can assign and send directly without saving a link first', async () => {
  const c = terminalSetup(setup()); try {
    c.configure(false); await c.service.sync(); const key = c.service.snapshot().tasks[0].key
    assert.equal(c.service.snapshot().tasks[0].stage, 'review')
    const preview = await c.service.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex', sessionId: 's-existing' })
    assert.equal(c.service.snapshot().tasks[0].sessionId, undefined)
    await c.service.approve(preview.previewId); assert.equal(c.dispatched.length, 1); assert.equal(c.service.snapshot().tasks[0].sessionId, 's-existing'); assert.equal(c.service.snapshot().tasks[0].stage, 'human-review')
  } finally { c.cleanup() }
})
test('legacy delivered and uncertain jobs retain original target before reassignment and restart', async () => {
  for (const status of ['delivered', 'uncertain']) {
    const c = terminalSetup(setup()); try {
      const key = await c.ready(), preview = await c.preview(key); await c.service.approve(preview.previewId); c.service.stop()
      const path = join(c.dir, 'erp-tasks.json'), ledger = JSON.parse(encryption.decryptString(Buffer.from(readFileSync(path, 'utf8'), 'base64')))
      delete ledger.tasks[0].dispatchTarget; ledger.tasks[0].dispatchStatus = status; delete ledger.history[0][1].dispatchTarget
      writeFileSync(path, encryption.encryptString(JSON.stringify(ledger)).toString('base64'))
      const reloaded = new ERPTaskService(c.dir, encryption, c.deps); await reloaded.sync(); await reloaded.assignTerminal(key, c.terminals[0]); reloaded.stop()
      const again = new ERPTaskService(c.dir, encryption, c.deps); await again.sync(); const card = again.snapshot().tasks[0]
      assert.equal(card.sessionId, 's-existing'); assert.equal(card.dispatchTarget.sessionId, 's1'); assert.equal(card.dispatchTarget.projectId, 'p1'); assert.equal(card.dispatchTarget.hostId, 'h1'); assert.equal(card.dispatchStatus, status); again.stop()
    } finally { c.cleanup() }
  }
})
test('slow terminal lookup cannot submit after preview expiry', async () => {
  const c = terminalSetup(setup()); try {
    let now = 1; c.deps.now = () => now; const key = await c.ready(), preview = await c.service.preview({ taskKey: key, projectId: 'p1', hostId: 'h1', agent: 'codex', sessionId: 's-existing' })
    c.deps.terminals = async () => { now += 120001; return c.terminals }
    await assert.rejects(c.service.approve(preview.previewId)); assert.equal(c.dispatched.length, 0); assert.equal(c.service.snapshot().tasks[0].jobId, undefined)
  } finally { c.cleanup() }
})
test('history-only legacy jobs are migrated during sync before immediate reassignment', async () => {
  const c = terminalSetup(setup()); try {
    const key = await c.ready(), preview = await c.preview(key); await c.service.approve(preview.previewId); c.service.stop()
    const path = join(c.dir, 'erp-tasks.json'), ledger = JSON.parse(encryption.decryptString(Buffer.from(readFileSync(path, 'utf8'), 'base64')))
    ledger.tasks = []; delete ledger.history[0][1].dispatchTarget; writeFileSync(path, encryption.encryptString(JSON.stringify(ledger)).toString('base64'))
    const reloaded = new ERPTaskService(c.dir, encryption, c.deps); await reloaded.sync(); await reloaded.assignTerminal(key, c.terminals[0]); const card = reloaded.snapshot().tasks[0]
    assert.equal(card.sessionId, 's-existing'); assert.equal(card.dispatchTarget.sessionId, 's1'); reloaded.stop()
  } finally { c.cleanup() }
})
test('uncertain new-terminal dispatch preserves original project even without returned session', async () => {
  const c = terminalSetup(setup()); try {
    const key = await c.ready(), preview = await c.preview(key); c.deps.dispatch = async () => { throw new Error('lost response') }; await c.service.approve(preview.previewId)
    assert.equal(c.service.snapshot().tasks[0].dispatchTarget.projectId, 'p1'); assert.equal(c.service.snapshot().tasks[0].dispatchTarget.sessionId, '')
    await c.service.assignTerminal(key, c.terminals[0]); assert.equal(c.service.snapshot().tasks[0].dispatchTarget.sessionId, ''); assert.equal(c.service.snapshot().tasks[0].dispatchStatus, 'uncertain')
  } finally { c.cleanup() }
})
