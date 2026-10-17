import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { projectVisibleSessions, withoutHostWorkspace } from '../src/shared/access-visibility.ts'

const require = createRequire(import.meta.url)
function harness() {
  const handlers = new Map(), sender = { send() {} }, dispatches = [], remoteCalls = [], ownerAssignments = []
  const principal = { id: 'actor-a', label: 'A', role: 'member', operateOthers: false, allowedRoots: ['/srv/allowed'] }
  const project = { id: 'project', name: 'Allowed', hostId: 'host', root: '/srv/allowed' }
  const state = { hosts: [{ id: 'host' }], projects: [project], notices: [], sessionNames: {}, tabs: [], activeTabs: {}, selectedProjectId: '', eventCursors: {} }
  const current = { status: () => 'connected', accessStatus: async () => ({ enabled: true }), accessIdentity: async () => principal, sessionList: [], assignSessionOwner: async (sessionId, ownerId) => { ownerAssignments.push([sessionId, ownerId]) }, api: async (method, path, body) => { remoteCalls.push([method, path, body]); if (method === 'GET' && path === '/api/sessions') return current.sessionList; dispatches.push(body); return current.receipt ?? { sessionId: 'a'.repeat(32) } }, setAccessCredential: async () => undefined }
  const store = { project: id => state.projects.find(item => item.id === id), host: id => id === 'host' ? state.hosts[0] : undefined, snapshot: () => structuredClone(state), removeSession: (hostId, sessionId) => { state.removedSession = [hostId, sessionId]; return state }, saveWorkspace: () => state, renameSession: () => { state.renamed = true; return state } }
  const erp = { snapshot: () => ({ connection: {}, tasks: [], links: {} }), approve: async () => ({}) }
  const module = { exports: {} }
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8') + '\nexports.testSetup = (s, c, e, w) => { store=s; connections.set("host",c); erpTasks=e; window=w; terminalCheckpoints={remove(){}}; attention={reset(){}}; registerIPC() }; exports.authorize = authorizeERPProject; exports.dispatch = dispatchERPTask; exports.erpTerminals = erpTerminals; exports.catalogue = erpTerminalCatalogue; exports.addConnection = (host,current) => connections.set(host,current); exports.resolveTerminal = resolveERPTerminal; exports.submit = submitERPTask; exports.receipt = erpSubmissionStatus; exports.auditRecords = visibleAuditRecords;'
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const localRequire = id => {
    if (id.startsWith('node:')) return require(id)
    if (id === 'electron') return { app: { whenReady: () => ({ then() {} }), on() {} }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } }
    if (id === '../shared/access-visibility') return { projectVisibleSessions, withoutHostWorkspace }
    return {}
  }
  vm.runInNewContext(compiled, { require: localRequire, exports: module.exports, module, process: { env: {} }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval })
  module.exports.testSetup(store, current, erp, { webContents: sender, isDestroyed: () => false })
  return { ...module.exports, principal, project, state, current, erp, handlers, dispatches, remoteCalls, ownerAssignments, invoke: (channel, ...args) => handlers.get(channel)({ sender }, ...args) }
}

test('main authorizes current server principal and canonical root, not renderer project IDs', async () => {
  const h = harness()
  assert.deepEqual(JSON.parse(JSON.stringify(await h.authorize('project', 'host'))), { actorId: 'actor-a', root: '/srv/allowed' })
  await assert.rejects(h.authorize('invented', 'host'), /Proyecto desconocido/)
  h.project.root = '/srv/allowed-foreign'
  await assert.rejects(h.authorize('project', 'host'), /no permite/)
  h.project.root = '/srv/allowed/../outside'
  await assert.rejects(h.authorize('project', 'host'), /no permite/)
  h.project.root = '/srv/allowed'; h.principal.revoked = true
  await assert.rejects(h.authorize('project', 'host'), /no válida/)
})

test('dispatch rechecks approved actor and exact root before contacting the remote endpoint', async () => {
  const h = harness(), job = { jobId: 'job', projectId: 'project', hostId: 'host', actorId: 'actor-a', root: '/srv/allowed', agent: 'codex', initialPrompt: 'Approved text; $(not shell)' }
  await h.dispatch(job)
  assert.equal(h.dispatches[0].root, '/srv/allowed'); assert.equal(h.dispatches[0].initialPrompt, job.initialPrompt)
  assert.equal(h.dispatches[0].ownerId, undefined)
  h.principal.id = 'actor-b'
  await assert.rejects(h.dispatch(job), /identidad cambió/)
  h.principal.id = 'actor-a'; h.project.root = '/srv/allowed/sub'
  await assert.rejects(h.dispatch(job), /destino o identidad/)
  assert.equal(h.dispatches.length, 1)
})

test('remote rejection never confirms a delivered ERP job and foreign IPC senders are blocked', async () => {
  const h = harness()
  h.current.api = async () => { throw new Error('remote authorization denied') }
  await assert.rejects(h.dispatch({ projectId: 'project', hostId: 'host', root: '/srv/allowed', actorId: 'actor-a' }), /authorization denied/)
  await assert.rejects(h.handlers.get('crow:erp-snapshot')({ sender: {} }), /no autorizada/)
})

test('credential switches wait for approval IPC completion rather than changing its actor mid-dispatch', async () => {
  const h = harness()
  let release, imported = false, entered
  const started = new Promise(resolve => { entered = resolve })
  h.erp.approve = async () => { entered(); await new Promise(resolve => { release = resolve }); return {} }
  h.current.setAccessCredential = async () => { imported = true }
  const approve = h.invoke('crow:erp-approve', 'nonce')
  await started
  const change = h.invoke('crow:access-import', 'host', 'individual-token')
  await new Promise(resolve => setImmediate(resolve)); assert.equal(imported, false)
  release(); await approve; await change; assert.equal(imported, true)
})

test('detail IPC is sender guarded and serialized with credential switches', async () => {
  const h = harness(); let release, entered, imported = false
  const started = new Promise(resolve => { entered = resolve })
  h.erp.loadDetail = async key => { assert.equal(key, 'task-key'); entered(); await new Promise(resolve => { release = resolve }); return { tasks: [] } }
  await assert.rejects(h.handlers.get('crow:erp-detail')({ sender: {} }, 'task-key'), /no autorizada/)
  const detail = h.invoke('crow:erp-detail', 'task-key'); await started
  h.current.setAccessCredential = async () => { imported = true }
  const change = h.invoke('crow:access-import', 'host', 'fictional-token')
  await new Promise(resolve => setImmediate(resolve)); assert.equal(imported, false)
  release(); await detail; await change; assert.equal(imported, true)
})

test('local rename cannot modify an invisible or read-only foreign terminal', async () => {
  const h = harness(), id = 'a'.repeat(32)
  h.current.api = async () => [{ id, readOnly: true }]
  await assert.rejects(h.invoke('crow:rename-session', 'host', id, 'foreign'), /no permitida/)
  assert.equal(h.state.renamed, undefined)
  h.current.api = async () => [{ id, readOnly: false }]
  await h.invoke('crow:rename-session', 'host', id, 'own')
  assert.equal(h.state.renamed, true)
})

test('admin can claim and delete a legacy unowned terminal after remote restart', async () => {
  const h = harness(), id = 'a'.repeat(32)
  h.principal.role = 'admin'
  h.current.sessionList = [{ id, readOnly: true, state: 'interrupted' }]
  await h.invoke('crow:delete-session', 'host', id)
  assert.deepEqual(h.ownerAssignments, [[id, 'actor-a']])
  assert.deepEqual(h.remoteCalls.slice(0, 2).map(([method, path]) => [method, path]), [['GET', '/api/sessions'], ['DELETE', `/api/sessions/${id}`]])
  assert.deepEqual(h.state.removedSession, ['host', id])
})

test('delete refuses an owned read-only terminal but cleans a stale local entry absent remotely', async () => {
  const h = harness(), id = 'b'.repeat(32)
  h.current.sessionList = [{ id, ownerId: 'actor-b', readOnly: true }]
  await assert.rejects(h.invoke('crow:delete-session', 'host', id), /no permitida/)
  assert.equal(h.state.removedSession, undefined)
  h.current.sessionList = []
  await h.invoke('crow:delete-session', 'host', id)
  assert.deepEqual(h.state.removedSession, ['host', id])
  assert.equal(h.remoteCalls.some(([method]) => method === 'DELETE'), false)
})

test('reconnection returns only permitted saved aliases without deleting offline or foreign metadata', async () => {
  const h = harness(), own = 'a'.repeat(32), foreign = 'b'.repeat(32)
  h.state.sessionNames = { ['host:' + own]: 'QA permitted', ['host:' + foreign]: 'Private foreign' }
  h.current.status = () => 'disconnected'
  assert.deepEqual(JSON.parse(JSON.stringify((await h.invoke('crow:get-state')).sessionNames)), {})
  h.current.status = () => 'connected'; h.current.api = async () => [{ id: own }]
  assert.deepEqual(JSON.parse(JSON.stringify((await h.invoke('crow:get-state')).sessionNames)), { ['host:' + own]: 'QA permitted' })
  h.current.api = async () => { throw new Error('Temporary scoped read failure') }
  assert.deepEqual(JSON.parse(JSON.stringify((await h.invoke('crow:get-state')).sessionNames)), {})
  assert.equal(Object.keys(h.state.sessionNames).length, 2)
})

test('audit list/detail/export projections hide historical private session records from members', async () => {
  const h = harness(), mine = 'a'.repeat(32), foreign = 'b'.repeat(32)
  const rows = [{ hostId: 'host', sessionId: mine, input: 'mine' }, { hostId: 'host', sessionId: foreign, input: 'private' }, { hostId: 'unknown-host', sessionId: mine, input: 'unknown' }]
  h.current.api = async () => [{ id: mine }]
  assert.deepEqual(JSON.parse(JSON.stringify(await h.auditRecords(rows))), [rows[0]])
  h.principal.role = 'admin'
  assert.deepEqual(JSON.parse(JSON.stringify(await h.auditRecords(rows))), rows.slice(0, 2))
  h.current.status = () => 'disconnected'
  assert.deepEqual(JSON.parse(JSON.stringify(await h.auditRecords(rows))), [])
})


test('ERP terminal catalogue filters exact actor ownership, canonical project, alive agent and current host', async () => {
  const h = harness(), own = { id: 'a'.repeat(32), ownerId: 'actor-a', root: '/srv/allowed', state: 'running', mode: 'normal', agent: 'codex' }
  h.state.sessionNames['host:' + own.id] = 'Custom alias'
  h.current.sessionList = [own, { ...own, id: 'foreign', ownerId: 'actor-b' }, { ...own, id: 'closed', state: 'exited' }, { ...own, id: 'wrong-root', root: '/srv/allowed/sub' }, { ...own, id: 'read-only', readOnly: true }, { ...own, id: 'shell', agent: 'shell' }]
  h.principal.role = 'admin'; h.principal.operateOthers = true
  const terminals = await h.erpTerminals('project', 'host'); assert.deepEqual(Array.from(terminals, item => item.sessionId), [own.id, 'read-only', 'shell']); assert.equal(terminals[0].name, 'Custom alias'); assert.equal(terminals[1].canSubmit, false); assert.equal(terminals[2].canSubmit, false)
  await assert.rejects(h.erpTerminals('project', 'other'))
  h.current.status = () => 'disconnected'; await assert.rejects(h.erpTerminals('project', 'host'), /host/)
})
test('existing ERP send uses durable UUID submission and read-only status, never raw PTY input', async () => {
  const h = harness(), id = 'a'.repeat(32), job = { jobId: '11111111-1111-4111-8111-111111111111', projectId: 'project', hostId: 'host', sessionId: id, actorId: 'actor-a', root: '/srv/allowed', agent: 'codex', initialPrompt: 'Exact approved detail' }
  h.current.sessionList = [{ id, ownerId: 'actor-a', root: job.root, state: 'running', mode: 'normal', agent: 'codex' }]
  h.current.receipt = { requestId: job.jobId, sessionId: id, status: 'written' }
  assert.equal((await h.submit(job)).status, 'written')
  const post = h.remoteCalls.find(call => call[0] === 'POST'); assert.equal(post[1], '/api/sessions/' + id + '/chat/submit'); assert.equal(post[2].requestId, job.jobId); assert.equal(post[2].text, job.initialPrompt)
  h.current.receipt.status = 'accepted'; assert.equal((await h.receipt(job, job.jobId)).status, 'accepted')
  assert.equal(h.remoteCalls.filter(call => call[0] === 'POST').length, 1)
  h.principal.id = 'actor-b'; await assert.rejects(h.submit(job)); await assert.rejects(h.receipt(job, job.jobId)); assert.equal(h.remoteCalls.filter(call => call[0] === 'POST').length, 1)
  for (const channel of ['crow:erp-terminals', 'crow:erp-assign-terminal', 'crow:erp-terminal-view', 'crow:erp-reconcile']) await assert.rejects(h.handlers.get(channel)({ sender: {} }), /no autorizada/)
})

test('read-only receipt remains queryable after agent exit and rejects late actor changes', async () => {
  const h = harness(), id = 'a'.repeat(32), target = { projectId: 'project', hostId: 'host', sessionId: id, actorId: 'actor-a', root: '/srv/allowed', agent: 'codex' }, jobId = '11111111-1111-4111-8111-111111111111'
  h.current.sessionList = [{ id, ownerId: 'actor-a', root: target.root, state: 'exited', mode: 'normal', agent: 'codex' }]
  h.current.receipt = { requestId: jobId, sessionId: id, status: 'accepted' }
  assert.equal((await h.receipt(target, jobId)).status, 'accepted')
  const original = h.current.api
  h.current.api = async (...args) => { const value = await original(...args); if (args[1].includes('/chat/submit')) h.principal.id = 'actor-revoked'; return value }
  await assert.rejects(h.receipt(target, jobId)); assert.equal(h.remoteCalls.filter(call => call[0] === 'POST').length, 0)
})
test('modified ERP sources remain valid UTF8 without replacement characters', () => {
  for (const path of ['src/main/erp-task-service.ts','src/main/index.ts','src/renderer/src/ERPTaskKanban.tsx','src/renderer/src/App.tsx']) assert.ok(!readFileSync(new URL('../' + path, import.meta.url), 'utf8').includes('\ufffd'), path)
})

test('global terminal discovery derives unique registered projects and isolates offline hosts', async () => {
  const h = harness(); h.state.hosts[0].name = 'Readable host'; h.state.hosts.push({ id: 'offline', name: 'Offline host' })
  h.state.projects.push({ id: 'other', name: 'Other project', hostId: 'host', root: '/srv/allowed/other' }, { id: 'offline-p', name: 'Offline', hostId: 'offline', root: '/srv/offline' })
  h.current.sessionList = [{ id:'one',ownerId:'actor-a',root:'/srv/allowed',state:'running',agent:'codex',mode:'normal' },{ id:'two',ownerId:'actor-a',root:'/srv/allowed/other',state:'running',agent:'claude',mode:'normal' },{ id:'foreign',ownerId:'actor-b',root:'/srv/allowed',state:'running',agent:'codex',mode:'normal' }]
  const result = await h.catalogue(); assert.equal(h.remoteCalls.filter(call=>call[0]==='GET'&&call[1]==='/api/sessions').length,1); assert.deepEqual(Array.from(result.terminals, item => item.projectId).sort(), ['other','project']); assert.equal(result.terminals[0].hostName,'Readable host'); assert.ok(result.warnings.some(message=>message.includes('Offline host')))
  const linked = await h.resolveTerminal({hostId:'host',sessionId:'two',projectId:'project'});assert.equal(linked.projectId,'other')
  h.state.projects.push({id:'ambiguous',name:'Ambiguous',hostId:'host',root:'/srv/allowed/other'})
  const ambiguous = await h.catalogue(); assert.equal(ambiguous.terminals.some(item=>item.sessionId==='two'),false);await assert.rejects(h.resolveTerminal({hostId:'host',sessionId:'two'}));assert.ok(ambiguous.warnings.some(message=>/comparten|ambigu/i.test(message)))
})
test('ERP snapshot and metadata terminal assignment do not wait for a slow ERP operation', async () => {
  const h = harness();let release,entered;const waiting = new Promise(resolve=>{entered=resolve})
  h.erp.sync = async () => {entered();await new Promise(resolve=>{release=resolve});return {tasks:[]}}
  h.erp.assignTerminal = async () => ({tasks:[{sessionId:'one'}]})
  const refresh = h.invoke('crow:erp-sync');await waiting
  const state = await h.invoke('crow:erp-snapshot');assert.equal(state.tasks.length,0)
  const assigned = await h.invoke('crow:erp-assign-terminal','key',{hostId:'host',sessionId:'one'});assert.equal(assigned.tasks[0].sessionId,'one');release();await refresh
})

test('chosen-terminal resolution never waits for unrelated connected failing hosts', async () => {
  const h=harness();h.state.hosts.push({id:'slow',name:'Slow'});h.state.projects.push({id:'slow-p',name:'Slow project',hostId:'slow',root:'/srv/slow'});let touched=false
  h.addConnection('slow',{status:()=> 'connected',accessStatus:async()=>{touched=true;throw new Error('unavailable')}})
  h.current.sessionList=[{id:'mine',ownerId:'actor-a',root:'/srv/allowed',state:'running',agent:'codex',mode:'normal'}]
  assert.equal((await h.resolveTerminal({hostId:'host',sessionId:'mine'})).projectId,'project');assert.equal(touched,false)
  const catalogue=await h.catalogue();assert.equal(catalogue.terminals.length,1);assert.ok(catalogue.warnings.some(message=>message.includes('Slow')))
})
test('actual app startup launches metadata refresh without awaiting it before host connections', () => {
  const source=readFileSync(new URL('../src/main/index.ts',import.meta.url),'utf8')
  const boot=source.slice(source.indexOf("app.whenReady().then"))
  assert.match(boot,/createWindow\(\)[\s\S]*void refreshERPProjects\(\)\.then\(\(\) => erpTasks\.startupRefresh\(\)\)/)
  assert.match(boot,/for \(const host of store\.snapshot\(\)\.hosts\) void connection\(host\.id\)\.connect\(\)/)
})
