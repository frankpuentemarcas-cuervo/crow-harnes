import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
function harness() {
  const handlers = new Map(), invalidated = [], sender = { send() {} }
  const host = { id: 'host', target: 'user@test', port: 22, remotePort: 7337 }
  const actor = { id: 'member-a', role: 'member', allowedRoots: ['/srv/project'], operateOthers: false }
  const state = { hosts: [host], projects: [{ id: 'project', hostId: 'host', name: 'Project', root: '/srv/project' }], notices: [{ id: 'notice', hostId: 'host', sessionId: 'a'.repeat(32), kind: 'turn-complete', at: '2026-10-10T00:00:00Z', requiresAttention: true, classification: { detail: 'PRIVATE RESPONSE' }, message: 'PRIVATE' }], tabs: [], activeTabs: {}, sessionNames: {}, eventCursors: {} }
  const store = { host: id => id === host.id ? host : undefined, snapshot: () => state, saveHost: value => value, removeHost: () => state, removeSession: () => state, saveWorkspace: () => state }
  const connection = { status: () => 'connected', accessStatus: async () => ({ enabled: true }), accessIdentity: async () => actor, stop() {}, setAccessCredential: async () => undefined }
  const mobile = { invalidateHost: id => invalidated.push(id), start: async input => ({ running: true, input }), stop: async () => ({ running: false }), status: () => ({ running: true }), invite: async input => ({ invitationCode: 'one-use', input }), revoke: id => invalidated.push(`device:${id}`) }
  const accounts = { list: () => [{ id: 'secret-account-id', provider: 'codex', label: 'PRIVATE account', identity: 'person@email', error: 'sensitive failure', status: 'ready', updatedAt: 1000, windows: [{ label: 'PRIVATE Weekly', usedPercent: 40, resetsAt: 2000 }] }] }
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8') + `
exports.setup = (s,c,m,a,w) => {store=s; connections.set('host',c); mobile=m; accountUsage=a; window=w; vault={forget(){}}; attention={reset(){}}; registerIPC()};
exports.auth = mobileAuthSnapshot; exports.workspace = mobileWorkspaceSnapshot; exports.quotas = mobileCachedQuotas; exports.notices = mobileCachedNotices; exports.invalidate = invalidateMobileHost;`
  const module = { exports: {} }
  const localRequire = id => {
    if (id.startsWith('node:')) return require(id)
    if (id === 'electron') return { app: { whenReady: () => ({ then() {} }), on() {} }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
    if (id === '../shared/access-visibility') return { withoutHostWorkspace: value => value, projectVisibleSessions: value => value }
    return {}
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { require: localRequire, module, exports: module.exports, process: { env: {} }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval })
  module.exports.setup(store, connection, mobile, accounts, { webContents: sender, isDestroyed: () => false })
  return { ...module.exports, actor, host, connection, invalidated, handlers, invoke: (name, ...args) => handlers.get(name)({ sender }, ...args) }
}

test('Android snapshot binds a current individual actor without exposing credentials', async () => {
  const h = harness(), first = plain(await h.auth('host'))
  assert.equal(first.actorId, 'member-a'); assert.equal(first.operateOthers, false)
  assert.deepEqual(first.allowedRoots, ['/srv/project'])
  h.actor.role = 'admin'; assert.equal((await h.auth('host')).operateOthers, false)
  h.actor.operateOthers = true; assert.equal((await h.auth('host')).operateOthers, true)
  h.actor.role = 'member'; assert.equal((await h.auth('host')).operateOthers, false)
  h.actor.operateOthers = false
  h.actor.allowedRoots = ['/srv']; assert.deepEqual(plain(await h.auth('host')).allowedRoots, ['/srv/project'])
  h.actor.allowedRoots = ['/srv/project-foreign']; await assert.rejects(h.auth('host'), /no tiene proyectos/)
  h.actor.allowedRoots = ['/srv/project']
  assert.deepEqual(Object.keys(first).sort(), ['actorId', 'allowedRoots', 'generation', 'operateOthers'])
  h.invalidate('host'); const second = await h.auth('host')
  assert.notEqual(second.generation, first.generation)
  h.actor.revoked = true; await assert.rejects(h.auth('host'), /no está autorizada/)
})

test('legacy bootstrap and disconnected hosts cannot enroll Android', async () => {
  const h = harness(); h.connection.accessIdentity = async () => ({ role: 'legacy', label: 'Bootstrap' })
  await assert.rejects(h.auth('host'), /acceso individual Crow/)
  h.connection.status = () => 'disconnected'
  await assert.rejects(h.auth('host'), /Conectá el host/)
})

test('mobile snapshot authorizes configured admin projects without ERP whitelist or foreign-operation grant', async () => {
  const h = harness()
  assert.deepEqual(plain(h.workspace()).projects, [])
  h.actor.role = 'admin'; h.actor.allowedRoots = []
  const binding = await h.auth('host')
  assert.deepEqual(plain(binding.allowedRoots), ['/srv/project']); assert.equal(binding.operateOthers, false)
  assert.equal(h.workspace().projects[0].id, 'project')
  h.invalidate('host'); assert.deepEqual(plain(h.workspace()).hosts, [])
})

test('snapshot rejects identity changes while awaiting authorization and noncanonical roots', async () => {
  const h = harness(); h.connection.accessIdentity = async () => { h.invalidate('host'); return h.actor }
  await assert.rejects(h.auth('host'), /identidad cambió/)
  h.connection.accessIdentity = async () => h.actor; h.actor.allowedRoots = ['/srv/project/../outside']
  await assert.rejects(h.auth('host'), /no tiene proyectos/)
})

test('cached quota and notice DTOs omit account identities and classification text', () => {
  const h = harness(), quotas = plain(h.quotas()), notices = plain(h.notices())
  assert.deepEqual(quotas, [{ id: 'codex:1', label: 'Codex 1', provider: 'codex', state: 'ready', sampledAt: '1970-01-01T00:00:01.000Z', windows: [{ label: 'Ventana 1', usedPercent: 40, resetsAt: '1970-01-01T00:00:02.000Z' }] }])
  assert.equal(JSON.stringify({ quotas, notices }).includes('PRIVATE'), false)
  assert.equal(notices[0].classification, undefined); assert.equal(quotas[0].identity, undefined)
})

test('desktop-only mobile IPC forwards typed configuration and rejects foreign senders', async () => {
  const h = harness(), input = { address: '192.168.1.5', publicOrigin: 'https://test.ts.net' }
  assert.deepEqual(plain(await h.invoke('crow:mobile-start', input)).input, input)
  const grant = { projectIds: ['project'], capabilities: { quotas: false } }
  assert.deepEqual(plain(await h.invoke('crow:mobile-invite', grant)).input, grant)
  await h.invoke('crow:mobile-revoke', 'phone'); assert.deepEqual(h.invalidated, ['device:phone'])
  await assert.rejects(h.handlers.get('crow:mobile-invite')({ sender: {} }, grant), /no autorizada/)
})

test('host edits, removal, and credential imports invalidate paired host grants', async () => {
  const h = harness()
  await h.invoke('crow:save-host', { ...h.host, target: 'other@test' })
  await h.invoke('crow:remove-host', 'host')
  assert.deepEqual(h.invalidated, ['host', 'host'])
  const fresh = harness(); await fresh.invoke('crow:access-import', 'host', 'redacted')
  assert.deepEqual(fresh.invalidated, ['host', 'host'])
})
