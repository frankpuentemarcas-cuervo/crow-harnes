import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
const mobileAuth = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(readFileSync(new URL('../src/main/mobile-device-auth.ts', import.meta.url), 'utf8'), { mode: 'transform' })).toString('base64'))

const require = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
function harness() {
  const handlers = new Map(), invalidated = [], suspended = [], mobileInvites = [], qrPayloads = [], sender = { send() {} }
  const host = { id: 'host', name: 'Test host', target: 'user@test', port: 22, remotePort: 7337 }
  const actor = { id: 'member-a', role: 'member', allowedRoots: ['/srv/project'], operateOthers: false }
  const state = { hosts: [host], projects: [{ id: 'project', hostId: 'host', name: 'Project', root: '/srv/project' }], notices: [{ id: 'notice', hostId: 'host', sessionId: 'a'.repeat(32), kind: 'turn-complete', at: '2026-10-10T00:00:00Z', requiresAttention: true, classification: { detail: 'PRIVATE RESPONSE' }, message: 'PRIVATE' }], tabs: [], activeTabs: {}, sessionNames: {}, eventCursors: {} }
  const store = { host: id => state.hosts.find(item => item.id === id), snapshot: () => state, saveHost: value => value, removeHost: () => state, removeSession: () => state, saveWorkspace: () => state, renameSession: (hostId, sessionId, name) => { state.sessionNames[`${hostId}:${sessionId}`] = name; return state } }
  const hostCalls = [], sessionList = [], assigned = []
  const connection = { status: () => 'connected', accessStatus: async () => ({ enabled: true }), accessIdentity: async () => actor, assignSessionOwner: async (sessionId, ownerId) => { assigned.push([sessionId, ownerId]) }, api: async (method, path, body) => { hostCalls.push([method, path, body]); return path === '/api/mobile/invite' ? { version: 2, gatewayId: 'linux', invitationCode: 'linux-once', expiresAt: '2099-01-01T00:00:00Z', endpoints: [] } : path === '/api/sessions' ? sessionList : {} }, stop() {}, setAccessCredential: async () => undefined }
  const mobile = { invalidateHost: id => invalidated.push(id), suspendHost: id => suspended.push(id), start: async input => ({ running: true, input }), stop: async () => ({ running: false }), status: () => ({ running: true, relayUrl: 'wss://crow.frabubu.com/v1/tunnel' }), invite: async input => { mobileInvites.push(input); return { version: 2, gatewayId: 'gateway', invitationCode: 'one-use', expiresAt: '2099-01-01T00:00:00Z', endpoints: input.pangolinAuth ? [{ kind: 'remote-public', url: 'https://crow.example.com', provider: 'pangolin', proxyAuthRequired: true, proxyAuth: { origin: 'https://crow.example.com', ...input.pangolinAuth } }] : [] } }, revoke: id => invalidated.push(`device:${id}`) }
  const accounts = { list: () => [{ id: 'secret-account-id', provider: 'codex', label: 'PRIVATE account', identity: 'person@email', error: 'sensitive failure', status: 'ready', updatedAt: 1000, windows: [{ label: 'PRIVATE Weekly', usedPercent: 40, resetsAt: 2000 }] }] }
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8') + `
exports.setup = (s,c,m,a,w) => {store=s; connections.set('host',c); mobile=m; accountUsage=a; window=w; vault={forget(){}}; gitLabTokens={remove(){},save(){},get(){}}; attention={reset(){}}; registerIPC()};
exports.addConnection = (id,c) => connections.set(id,c);
exports.auth = mobileAuthSnapshot; exports.workspace = mobileWorkspaceSnapshot; exports.quotas = mobileCachedQuotas; exports.notices = mobileCachedNotices; exports.invalidate = invalidateMobileHost; exports.suspend = suspendMobileHost;`
  const module = { exports: {} }
  const localRequire = id => {
    if (id.startsWith('node:')) return require(id)
    if (id === './mobile-device-auth') return mobileAuth
    if (id === 'qrcode') return { default: { toDataURL: async value => { qrPayloads.push(value); return 'data:image/png;base64,invite' } } }
    if (id === 'electron') return { app: { whenReady: () => ({ then() {} }), on() {} }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
    if (id === '../shared/access-visibility') return { withoutHostWorkspace: value => value, projectVisibleSessions: value => value }
    return {}
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { require: localRequire, module, exports: module.exports, process: { env: {} }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval })
  module.exports.setup(store, connection, mobile, accounts, { webContents: sender, isDestroyed: () => false })
  return { ...module.exports, actor, host, state, connection, hostCalls, sessionList, assigned, invalidated, suspended, mobileInvites, qrPayloads, handlers, invoke: (name, ...args) => handlers.get(name)({ sender }, ...args) }
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
  assert.deepEqual(Object.keys(first).sort(), ['actorId', 'allowedRoots', 'generation', 'operateOthers', 'role'])
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

test('host transport loss suspends grants without advancing identity generation', async () => {
  const h = harness(), before = plain(await h.auth('host'))
  h.connection.status = () => 'disconnected'; h.suspend('host')
  assert.deepEqual(h.suspended, ['host']); assert.deepEqual(h.invalidated, [])
  assert.deepEqual(plain(h.workspace()).projects, [])
  await assert.rejects(h.auth('host'), error => error instanceof mobileAuth.MobileHostUnavailableError)
  h.connection.status = () => 'connected'
  const after = plain(await h.auth('host'))
  assert.equal(after.generation, before.generation)
  assert.deepEqual(after, before)
})

test('authorization rejects confirmed HTTP denial but preserves trust on unavailable host response', async () => {
  for (const status of [401, 403, 404, 500, 503, undefined]) {
    const h = harness()
    h.connection.accessIdentity = async () => { throw Object.assign(new Error('failure'), { status }) }
    const expected = [401, 403, 404].includes(status) ? mobileAuth.MobileAuthorizationChangedError : mobileAuth.MobileHostUnavailableError
    await assert.rejects(h.auth('host'), error => error instanceof expected)
  }
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
  const invite = plain(await h.invoke('crow:mobile-invite', grant))
  assert.deepEqual(plain(h.mobileInvites[0]), grant)
  assert.equal(invite.qrDataUrl, 'data:image/png;base64,invite')
  assert.equal(invite.enrollment.invitationCode, 'one-use')
  assert.equal(invite.hostCount, 1)
  assert.deepEqual(h.hostCalls.map(item => item[1]), ['/api/mobile/config', '/api/mobile/invite'])
  await h.invoke('crow:mobile-revoke', 'phone'); assert.deepEqual(h.invalidated, ['device:phone'])
  await assert.rejects(h.handlers.get('crow:mobile-invite')({ sender: {} }, grant), /no autorizada/)
})

test('mobile enrollment needs at least one ready Linux host', async () => {
  const h = harness()
  h.connection.status = () => 'disconnected'
  await assert.rejects(h.invoke('crow:mobile-invite', { projectIds: ['project'], capabilities: {} }), /Ningún host seleccionado está listo.*Test host: sin conexión/)
  assert.equal(h.mobileInvites.length, 0)
})

test('renaming an unowned previous terminal assigns it to the current administrator', async () => {
  const h = harness(), id = 'd'.repeat(32)
  h.actor.role = 'admin'
  h.sessionList.push({ id, agent: 'claude', root: '/srv/project', state: 'running', readOnly: true })
  await h.invoke('crow:rename-session', 'host', id, 'Mi terminal')
  assert.deepEqual(h.assigned, [[id, 'member-a']])
  assert.equal(h.state.sessionNames[`host:${id}`], 'Mi terminal')
})

test('enabling individual access claims and preserves previously named unowned terminals', async () => {
  const h = harness(), id = 'e'.repeat(32)
  h.state.sessionNames[`host:${id}`] = 'Mi terminal anterior'
  h.sessionList.push({ id, agent: 'shell', root: '/srv/project', state: 'running' })
  h.connection.enableAccess = async label => { h.actor.role = 'admin'; return { principal: { id: h.actor.id, role: 'admin', label }, credential: 'f'.repeat(32) } }
  await h.invoke('crow:access-enable', 'host', 'Erick')
  assert.deepEqual(h.assigned, [[id, 'member-a']])
  assert.equal(h.state.sessionNames[`host:${id}`], 'Mi terminal anterior')
})

test('mobile QR omits disconnected and unauthorized hosts without including their projects', async () => {
  for (const failure of ['disconnected', 'unauthorized']) {
    const h = harness()
    h.state.hosts.push({ id: 'factory', name: 'FACTORY', target: 'user@factory', port: 22, remotePort: 7337 })
    h.state.projects.push({ id: 'factory-project', hostId: 'factory', name: 'Factory', root: '/srv/factory' })
    const factory = { ...h.connection, status: () => failure === 'disconnected' ? 'disconnected' : 'connected', api: async () => { throw Object.assign(new Error('individual access required'), { status: 403 }) } }
    h.addConnection('factory', factory)
    const result = plain(await h.invoke('crow:mobile-invite', { projectIds: ['project', 'factory-project'], capabilities: {} }))
    const qr = JSON.parse(h.qrPayloads[0])
    assert.equal(result.hostCount, 1)
    assert.equal(result.skippedHosts[0].name, 'FACTORY')
    assert.equal(qr.enrollments.length, 2)
    assert.equal(qr.enrollments[1].hostId, 'host')
    assert.deepEqual(plain(h.mobileInvites[0].projectIds), ['project'])
  }
})

test('credential-bearing Pangolin QR is encoded in the main process and returned only as a bitmap', async () => {
  const h = harness(), input = { projectIds: ['project'], pangolinAuth: { tokenId: 'resource-id', token: 'secret-token' } }
  const result = plain(await h.invoke('crow:mobile-invite', input))
  const qr = JSON.parse(h.qrPayloads[0])
  assert.equal(qr.version, 3)
  assert.equal(qr.enrollments.length, 2)
  assert.equal(qr.enrollments[0].enrollment.endpoints[0].proxyAuth.token, 'secret-token')
  assert.equal(qr.enrollments[0].enrollment.endpoints[0].proxyAuth.origin, 'https://crow.example.com')
  assert.equal(result.qrDataUrl, 'data:image/png;base64,invite')
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
  assert.equal(result.enrollment.endpoints[0].proxyAuth, undefined)
})

test('host edits, removal, and credential imports invalidate paired host grants', async () => {
  const h = harness()
  await h.invoke('crow:save-host', { ...h.host, target: 'other@test' })
  await h.invoke('crow:remove-host', 'host')
  assert.deepEqual(h.invalidated, ['host', 'host'])
  const fresh = harness(); await fresh.invoke('crow:access-import', 'host', 'redacted')
  assert.deepEqual(fresh.invalidated, ['host', 'host'])
})
