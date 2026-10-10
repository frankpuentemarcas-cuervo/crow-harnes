import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { projectVisibleSessions, withoutHostWorkspace } from '../src/shared/access-visibility.ts'

const require = createRequire(import.meta.url)
function harness() {
  const handlers = new Map(), sender = { send() {} }, dispatches = []
  const principal = { id: 'actor-a', label: 'A', role: 'member', operateOthers: false, allowedRoots: ['/srv/allowed'] }
  const project = { id: 'project', name: 'Allowed', hostId: 'host', root: '/srv/allowed' }
  const state = { hosts: [{ id: 'host' }], projects: [project], notices: [], sessionNames: {}, tabs: [], activeTabs: {}, selectedProjectId: '', eventCursors: {} }
  const current = { status: () => 'connected', accessStatus: async () => ({ enabled: true }), accessIdentity: async () => principal, api: async (method, path, body) => { if (path === '/api/sessions') return []; dispatches.push(body); return { sessionId: 'a'.repeat(32) } }, setAccessCredential: async () => undefined }
  const store = { project: id => id === project.id ? project : undefined, host: id => id === 'host' ? state.hosts[0] : undefined, snapshot: () => structuredClone(state), removeSession: () => state, saveWorkspace: () => state, renameSession: () => { state.renamed = true; return state } }
  const erp = { snapshot: () => ({ connection: {}, tasks: [], links: {} }), approve: async () => ({}) }
  const module = { exports: {} }
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8') + '\nexports.testSetup = (s, c, e, w) => { store=s; connections.set("host",c); erpTasks=e; window=w; attention={reset(){}}; registerIPC() }; exports.authorize = authorizeERPProject; exports.dispatch = dispatchERPTask; exports.auditRecords = visibleAuditRecords;'
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const localRequire = id => {
    if (id.startsWith('node:')) return require(id)
    if (id === 'electron') return { app: { whenReady: () => ({ then() {} }), on() {} }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } }
    if (id === '../shared/access-visibility') return { projectVisibleSessions, withoutHostWorkspace }
    return {}
  }
  vm.runInNewContext(compiled, { require: localRequire, exports: module.exports, module, process: { env: {} }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval })
  module.exports.testSetup(store, current, erp, { webContents: sender, isDestroyed: () => false })
  return { ...module.exports, principal, project, state, current, erp, handlers, dispatches, invoke: (channel, ...args) => handlers.get(channel)({ sender }, ...args) }
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
  assert.equal(h.dispatches[0].root, '/srv/allowed'); assert.equal(h.dispatches[0].prompt, job.initialPrompt)
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

test('local rename cannot modify an invisible or read-only foreign terminal', async () => {
  const h = harness(), id = 'a'.repeat(32)
  h.current.api = async () => [{ id, readOnly: true }]
  await assert.rejects(h.invoke('crow:rename-session', 'host', id, 'foreign'), /no permitida/)
  assert.equal(h.state.renamed, undefined)
  h.current.api = async () => [{ id, readOnly: false }]
  await h.invoke('crow:rename-session', 'host', id, 'own')
  assert.equal(h.state.renamed, true)
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
