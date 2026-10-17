import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto'

const ts = path => stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'), { mode: 'transform' })
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const registryURL = dataURL(ts('../src/main/mobile-device-auth.ts'))
const mobileAuth = await import(registryURL)
const trustStoreURL = dataURL(ts('../src/main/mobile-trust-store.ts').replace("from './mobile-device-auth'", `from '${registryURL}'`))
const { MobileTrustStore } = await import(trustStoreURL)
const ledgerURL = dataURL(ts('../src/main/mobile-mutation-ledger.ts'))
const mobileSharedURL = dataURL(ts('../src/shared/mobile-companion.ts'))
class Client extends EventEmitter {
  readyState = 1; bufferedAmount = 0; frames = []; ended = false
  send(value) { this.frames.push(JSON.parse(value)) }
  terminate() { this.ended = true; this.readyState = 3; this.emit('close') }
  close() { this.terminate() }
}
class SocketServer { handleUpgrade(_req, _socket, _head, callback) { callback(globalThis.__mobileClient = new Client()) } }
globalThis.__mobileFixture = { SocketServer }
const source = ts('../src/main/mobile-gateway.ts')
  .replace("import { app, safeStorage } from 'electron';", 'const app = { isPackaged: true }; const safeStorage = {};')
  .replace("import forge from 'node-forge';", 'const forge = {};')
  .replace("import { WebSocket, WebSocketServer } from 'ws';", 'const WebSocket = { OPEN: 1 }; const WebSocketServer = globalThis.__mobileFixture.SocketServer;')
  .replace("import { isPrivateLanIPv4 } from './mobile-network';", 'const isPrivateLanIPv4 = () => true;')
  .replace("import { networkInterfaces } from 'node:os';", "const networkInterfaces = () => ({ lan: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }] });")
  .replace("from '../shared/mobile-companion'", `from '${mobileSharedURL}'`)
  .replace("from './mobile-device-auth'", `from '${registryURL}'`)
  .replace("from './mobile-trust-store'", `from '${trustStoreURL}'`)
  .replace("from './mobile-mutation-ledger'", `from '${ledgerURL}'`)
const { MobileGateway, mobileRemoteConfig, mobileRelayConfig, listenMobileLoopback } = await import(dataURL(source))
const SESSION = 'a'.repeat(32), FOREIGN = 'b'.repeat(32), OUTSIDE = 'c'.repeat(32)
const terminalWrites = (c, type) => c.calls.filter(call => call.stream && (!type || call.body.type === type) || call.method === 'POST' && (type ? call.path.endsWith(`/${type}`) : /\/(input|resize)$/.test(call.path)))
function fixture(trustStore = { load: () => undefined, save() {} }) {
  const state = { hosts: [{ id: 'host', name: 'Windows', target: 'user@mock', port: 22, remotePort: 47000 }], projects: [{ id: 'p1', hostId: 'host', name: 'Work', root: '/work' }, { id: 'p2', hostId: 'host', name: 'Other', root: '/other' }], sessionNames: { [`host:${SESSION}`]: 'Mi terminal de QA', [`host:${FOREIGN}`]: 'Sesión privada' }, notices: [] }
  let binding = { actorId: 'alice', generation: 'one', allowedRoots: ['/work', '/other'], operateOthers: false, role: 'member' }
  let hostStatus = 'connected'
  let sessions = [
    { id: SESSION, agent: 'claude', mode: 'normal', ownerId: 'alice', root: '/work', state: 'running', seq: 4, startedAt: 'now', updatedAt: 'now' },
    { id: FOREIGN, agent: 'codex', mode: 'normal', ownerId: 'bob', root: '/work', state: 'running', seq: 4, startedAt: 'now', updatedAt: 'now', readOnly: true },
    { id: OUTSIDE, agent: 'codex', mode: 'normal', ownerId: 'alice', root: '/other', state: 'running', seq: 4, startedAt: 'now', updatedAt: 'now' }
  ]
  const calls = [], streams = new Map()
  let apiHook = () => {}
  const connection = {
    status: () => hostStatus,
    api: async (method, path, body) => {
      calls.push({ method, path, body })
      await apiHook(method, path, body)
      if (method === 'GET' && path.includes('/chat')) return { messages: [], hasMore: false, nextBefore: 0 }
      if (method === 'GET') return structuredClone(sessions)
      if (method === 'DELETE') return {}
      return { ...sessions[0], root: body?.root || sessions[0].root }
    },
    attach: async (id, _session, from, emit) => { streams.set(id, { emit, from }) },
    detach: id => streams.delete(id),
    send: (id, body) => calls.push({ stream: id, body })
  }
  const gateway = new MobileGateway({ trustStore, snapshot: () => state, configurationSnapshot: () => state, connection: () => connection, authSnapshot: async () => { if (!binding) throw new mobileAuth.MobileAuthorizationChangedError('legacy'); return structuredClone(binding) }, quotas: () => [{ id: 'safe', label: 'Trabajo', provider: 'claude', state: 'ready', windows: [], sampledAt: null }], notices: () => [{ id: 'event', hostId: 'host', sessionId: SESSION, kind: 'turn-complete', at: 'now', message: 'SECRET', classification: { detail: 'SECRET' } }, { id: 'hidden', hostId: 'host', sessionId: OUTSIDE, kind: 'turn-complete', at: 'now' }] })
  gateway.server = { close: cb => cb(), closeAllConnections() {} }; gateway.origin = 'https://192.168.1.8:4000'; gateway.gatewayId = 'test'; gateway.endpoints = [{ kind: 'lan-pinned', url: gateway.origin, certSHA256: 'pin' }]; gateway.cookieToken = 'cookie'; gateway.cookieExpires = Date.now() + 10000; gateway.pairingCode = '1234567890ABCDEF'; gateway.pairingExpires = Date.now() + 10000; gateway.browserSnapshot = gateway.snapshotDigest()
  async function request(path, method = 'GET', body, credential, headers = {}, proxy = false) {
    const req = new PassThrough(); req.url = path; req.method = method; req.headers = { ...headers, ...(credential ? { authorization: `Bearer ${credential}` } : {}) }; req.socket = { remoteAddress: 'mock' }
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(value) { this.value = value } }
    const pending = gateway.handle(req, res, proxy)
    if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body)); else req.end()
    await pending
    return { status: res.status, body: JSON.parse(res.value), headers: res.headers }
  }
  async function pair(capabilities = {}) {
    const invitation = await gateway.invite({ projectIds: ['p1'], capabilities }, 1)
    const result = await request('/api/v1/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Pixel' })
    assert.equal(result.status, 200)
    return result.body
  }
  async function socket(credential, sessionId = SESSION, from = 4, extra = '') {
    const req = { url: `/api/v1/stream?hostId=host&sessionId=${sessionId}&from=${from}${extra}`, headers: { authorization: `Bearer ${credential}` } }
    const transport = { denied: false, write() { this.denied = true }, destroy() {} }
    await gateway.upgrade(req, transport, Buffer.alloc(0), false)
    await new Promise(ok => setImmediate(ok))
    return transport.denied ? null : globalThis.__mobileClient
  }
  return { state, gateway, calls, streams, request, pair, socket, binding: value => binding = value, hostStatus: value => hostStatus = value, sessions: value => sessions = value, apiHook: value => apiHook = value }
}
test('v2 installation pairing persists encrypted trust and renews after restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'crow-mobile-installation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'mobile-trust.enc')
  const codec = value => Buffer.from([...value].map(byte => byte ^ 0x55)) // Test double only.
  const secure = { isEncryptionAvailable: () => true, encryptString: value => codec(Buffer.from(value)), decryptString: value => codec(value).toString() }
  const store = new MobileTrustStore(path, secure), c = fixture(store)
  const binding = { actorId: `installation:${'d'.repeat(32)}`, generation: 'one', allowedRoots: ['/work', '/other'], operateOthers: false, role: 'installation' }
  c.binding(binding)
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const invitation = await c.gateway.invite({ projectIds: ['p1'] })
  const paired = await c.request('/api/v2/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })
  assert.equal(paired.status, 200, JSON.stringify(paired.body))
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.body.credential)).status, 200)
  assert.equal(readFileSync(path).includes(Buffer.from(binding.actorId)), false)
  assert.equal(readFileSync(path).includes(Buffer.from(paired.body.credential)), false)
  const saved = new MobileTrustStore(path, secure).load()
  assert.deepEqual(saved.records[0].scopes[0].binding, binding)

  const restarted = fixture(new MobileTrustStore(path, secure))
  restarted.binding(binding)
  const challenge = await restarted.request('/api/v2/device-challenge', 'POST', { deviceId: paired.body.device.id })
  assert.equal(challenge.status, 200)
  const renewed = await restarted.request('/api/v2/device-renew', 'POST', { deviceId: paired.body.device.id, challengeId: challenge.body.challengeId, signature: sign('sha256', mobileAuth.deviceProofPayload(challenge.body), keys.privateKey).toString('base64') })
  assert.equal(renewed.status, 200)
  assert.equal((await restarted.request('/api/v1/bootstrap', 'GET', undefined, renewed.body.credential)).status, 200)
  restarted.gateway.revoke(paired.body.device.id)
  assert.deepEqual(store.load().records, [])
})

test('pairing persistence failures report gateway unavailable instead of a disconnected host', async () => {
  const c = fixture({ load: () => undefined, save(value) { if (value.records.length) throw new Error('private disk failure') } })
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const invitation = await c.gateway.invite({ projectIds: ['p1'] })
  const paired = await c.request('/api/v2/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })
  assert.equal(paired.status, 503)
  assert.equal(paired.body.code, 'GATEWAY_UNAVAILABLE')
  assert.equal(JSON.stringify(paired.body).includes('private disk failure'), false)
  assert.equal(c.gateway.registry.records.size, 0)
})

test('native pairing and bootstrap expose scoped DTOs, not reusable QR tokens or roots', async () => {
  const c = fixture(), paired = await c.pair()
  const boot = await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)
  assert.equal(boot.status, 200); assert.equal(boot.body.projects.length, 1); assert.equal(boot.body.projects[0].root, undefined)
  assert.equal(boot.body.devices[0].id, paired.device.id)
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, undefined, { cookie: 'crow_mobile=cookie' })).status, 401)
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential, { origin: 'https://attacker.invalid' })).status, 403)
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential, { origin: 'https://attacker.invalid' })).headers['X-Crow-Mobile-API'], '1')
  assert.equal((await c.request('/api/state', 'GET', undefined, paired.credential, {}, true)).status, 404)
})

test('Windows gateway exposes chat history only to the owner and forwards authorized pages', async () => {
  const c = fixture()
  c.sessions([
    { id: SESSION, agent: 'claude', mode: 'normal', ownerId: 'alice', root: '/work', state: 'running', hooksActive: true, seq: 8 },
    { id: FOREIGN, agent: 'codex', mode: 'normal', ownerId: 'bob', root: '/work', state: 'running', hooksActive: true, seq: 3 },
  ])
  const paired = await c.pair({ input: true })
  const sessions = await c.request('/api/v1/sessions?hostId=host', 'GET', undefined, paired.credential)
  assert.equal(sessions.status, 200)
  assert.deepEqual(sessions.body.map(session => [session.agent, session.chatAvailable]), [['claude', true], ['codex', false]])
  const result = await c.request(`/api/v1/chat?hostId=host&sessionId=${SESSION}&after=4&limit=12`, 'GET', undefined, paired.credential)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body, { messages: [], hasMore: false, nextBefore: 0 })
  assert.equal(c.calls.at(-1).path, `/api/sessions/${SESSION}/chat?after=4&limit=12`)
  assert.equal(c.calls.at(-1).method, 'GET')
  const codex = await c.request(`/api/v1/chat?hostId=host&sessionId=${FOREIGN}`, 'GET', undefined, paired.credential)
    assert.equal(codex.status, 403)
    assert.notEqual(c.calls.at(-1).path, `/api/sessions/${FOREIGN}/chat`)
  assert.equal((await c.request(`/api/v1/chat?hostId=host&sessionId=${SESSION}&after=4&before=2`, 'GET', undefined, paired.credential)).status, 400)
  assert.equal((await c.request(`/api/v1/chat?hostId=host&hostId=host&sessionId=${SESSION}`, 'GET', undefined, paired.credential)).status, 400)
  assert.equal((await c.request(`/api/v1/chat?hostId=host&sessionId=${SESSION}&limit=0`, 'GET', undefined, paired.credential)).status, 400)
})

test('v2 structured chat submit is idempotent, validates text, and fails closed for old hosts', async () => {
  const c = await keyFixture()
  c.sessions([{ id: SESSION, agent: 'claude', mode: 'normal', ownerId: 'alice', root: '/work', state: 'running', hooksActive: true, seq: 8 }])
  const body = { hostId: 'host', sessionId: SESSION, requestId: randomUUID(), text: 'hello 🙂' }
  const route = '/api/v2/chat-submit'
  const first = await c.request(route, 'POST', body, c.credential)
  assert.equal(first.status, 200, JSON.stringify({ body:first.body, calls:c.calls }))
  assert.equal((await c.request(route, 'POST', body, c.credential)).status, 200)
  assert.equal(c.calls.filter(call => call.path === `/api/sessions/${SESSION}/chat/submit`).length, 1)
  const conflict = await c.request(route, 'POST', { ...body, text: 'different' }, c.credential)
  assert.equal(conflict.status, 409)
  const before = c.calls.length
  assert.equal((await c.request(route, 'POST', { ...body, requestId: randomUUID(), text: 'bad\u001b' }, c.credential)).status, 400)
  assert.equal(c.calls.length, before)
  c.apiHook((method, path) => { if (method === 'POST' && path.endsWith('/chat/submit')) throw Object.assign(new Error('404 page not found'), { status: 404 }) })
  const oldHost = await c.request(route, 'POST', { ...body, requestId: randomUUID() }, c.credential)
  assert.equal(oldHost.status, 501, JSON.stringify({ body:oldHost.body, calls:c.calls.slice(-3) }))
  assert.equal(oldHost.body.code, 'STRUCTURED_CHAT_UNAVAILABLE')
})

test('administrator override does not grant access to a foreign chat transcript', async () => {
  const c = fixture()
  c.binding({ actorId: 'alice', generation: 'one', allowedRoots: ['/work'], operateOthers: true, role: 'admin' })
  c.sessions([{ id: FOREIGN, agent: 'codex', mode: 'normal', ownerId: 'bob', root: '/work', state: 'running', hooksActive: true }])
  const paired = await c.pair({ input: true })
  const response = await c.request(`/api/v1/chat?hostId=host&sessionId=${FOREIGN}`, 'GET', undefined, paired.credential)
  assert.equal(response.status, 403)
  assert.notEqual(c.calls.at(-1).path, `/api/sessions/${FOREIGN}/chat`)
})

test('multi-project device authorization checks the host once per validation', async () => {
  const c = fixture(), original = c.gateway.deps.authSnapshot
  let checks = 0
  c.gateway.deps.authSnapshot = async id => { checks++; return original(id) }
  const invitation = await c.gateway.invite({ projectIds: ['p1', 'p2'] }, 1)
  const paired = await c.request('/api/v1/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android' })
  assert.equal(paired.status, 200)
  checks = 0
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.body.credential)).status, 200)
  assert.equal(checks, 1)
})

test('v2 installation input and resize preserve owner checks and dispatch once', async () => {
  const c = fixture(), owner = `installation:${'d'.repeat(32)}`
  c.binding({ actorId: owner, generation: 'one', allowedRoots: ['/work', '/other'], operateOthers: false, role: 'installation' })
  c.sessions([{ id: SESSION, agent: 'claude', root: '/work', ownerId: owner, state: 'running', readOnly: false }])
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const invitation = await c.gateway.invite({ projectIds: ['p1'], capabilities: { input: true } })
  const paired = await c.request('/api/v2/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })
  assert.equal(paired.status, 200)
  const client = await c.socket(paired.body.credential), streamId = client.frames.find(frame => frame.type === 'ready').streamId
  for (const [route, value] of [['input', { data: 'aGk=' }], ['resize', { cols: 80, rows: 24 }]]) {
    const body = { streamId, requestId: randomUUID(), ...value }
    assert.equal((await c.request(`/api/v1/${route}`, 'POST', body, paired.body.credential)).status, 200)
    assert.equal((await c.request(`/api/v1/${route}`, 'POST', body, paired.body.credential)).status, 200)
    assert.equal(terminalWrites(c, route).length, 1)
  }
  c.sessions([{ id: SESSION, agent: 'claude', root: '/work', ownerId: `installation:${'e'.repeat(32)}`, readOnly: true }])
  const denied = await c.request('/api/v1/input', 'POST', { streamId, requestId: randomUUID(), data: 'aGk=' }, paired.body.credential)
  assert.notEqual(denied.status, 200)
  assert.equal(terminalWrites(c, 'input').length, 1)
})
test('offline or unauthorized selected projects remain visible but receive no operational scope', async () => {
  const c = fixture()
  c.hostStatus('disconnected')
  const invitation = await c.gateway.invite({ projectIds: ['p1', 'p2'] }, 1)
  const paired = await c.request('/api/v1/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Pixel' })
  assert.equal(paired.status, 200)
  assert.deepEqual(paired.body.device.projectIds, [])
  assert.deepEqual(paired.body.device.unavailableProjects.map(project => [project.id, project.availability]), [['p1', 'server-disconnected'], ['p2', 'server-disconnected']])
  const boot = await c.request('/api/v1/bootstrap', 'GET', undefined, paired.body.credential)
  assert.equal(boot.status, 200)
  assert.deepEqual(boot.body.projects.map(project => [project.id, project.availability]), [['p1', 'server-disconnected'], ['p2', 'server-disconnected']])
  assert.equal(boot.body.hosts[0].status, 'disconnected')
  assert.deepEqual((await c.request('/api/v1/sessions?hostId=host', 'GET', undefined, paired.body.credential)).body, [])
  assert.equal(c.gateway.devices().length, 1)
})
test('selected project outside the active identity grant is display-only instead of failing the whole invitation', async () => {
  const c = fixture()
  c.binding({ actorId: 'alice', generation: 'one', allowedRoots: ['/work'], operateOthers: false, role: 'member' })
  const invitation = await c.gateway.invite({ projectIds: ['p1', 'p2'] }, 1)
  const paired = await c.request('/api/v1/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Pixel' })
  assert.equal(paired.status, 200)
  assert.deepEqual(paired.body.device.projectIds, ['p1'])
  const boot = await c.request('/api/v1/bootstrap', 'GET', undefined, paired.body.credential)
  assert.deepEqual(boot.body.projects.map(project => [project.id, project.availability]), [['p1', 'available'], ['p2', 'authorization-required']])
})
test('read-only enrollment denies create/wake/close/quotas and returns foreign sessions readonly', async () => {
  const c = fixture(), paired = await c.pair()
  const result = await c.request('/api/v1/sessions?hostId=host', 'GET', undefined, paired.credential)
  assert.equal(result.body.length, 2); assert.equal(result.body.find(s => s.id === FOREIGN).canOperate, false)
  assert.equal(result.body.find(s => s.id === SESSION).name, 'Mi terminal de QA')
  assert.equal(result.body.find(s => s.id === FOREIGN).name, undefined, 'foreign read-only sessions must not expose saved aliases')
  assert.equal(result.body[0].root, undefined); assert.equal(result.body[0].promptCache, undefined)
  for (const route of ['wake', 'close']) assert.equal((await c.request(`/api/v1/${route}`, 'POST', { hostId: 'host', sessionId: SESSION }, paired.credential)).status, 403)
  assert.equal((await c.request('/api/v1/sessions', 'POST', { hostId: 'host', projectId: 'p1', agent: 'claude' }, paired.credential)).status, 403)
  assert.equal((await c.request('/api/v1/quotas', 'GET', undefined, paired.credential)).status, 403)
})
test('admin sees Crow aliases for legacy unowned terminals without exposing foreign aliases', async () => {
  const c = fixture()
  c.binding({ actorId: 'alice', generation: 'one', allowedRoots: ['/work'], operateOthers: false, role: 'admin' })
  c.sessions([{ id: SESSION, agent: 'claude', mode: 'normal', root: '/work', state: 'running', seq: 4, startedAt: 'now', updatedAt: 'now' }, { id: FOREIGN, agent: 'codex', mode: 'normal', ownerId: 'bob', root: '/work', state: 'running', seq: 4, startedAt: 'now', updatedAt: 'now', readOnly: true }])
  const paired = await c.pair()
  const result = await c.request('/api/v1/sessions?hostId=host', 'GET', undefined, paired.credential)
  assert.equal(result.body.find(session => session.id === SESSION).name, 'Mi terminal de QA')
  assert.equal(result.body.find(session => session.id === FOREIGN).name, undefined)
})
test('write grants remain narrowed by owner, project scope, agent enum and normal mode', async () => {
  const c = fixture(), paired = await c.pair({ input: true, create: true, close: true })
  const post = (route, body) => c.request(`/api/v1/${route}`, 'POST', body, paired.credential)
  assert.equal((await post('wake', { hostId: 'host', sessionId: FOREIGN })).status, 400)
  assert.equal((await post('close', { hostId: 'host', sessionId: OUTSIDE })).status, 400)
  for (const agent of ['shell', 'agy', 'wrong']) assert.equal((await post('sessions', { hostId: 'host', projectId: 'p1', agent })).status, 400)
  for (const extra of [{ mode: 'bypass' }, { root: '/work' }, { ownerId: 'alice' }, { projectId: 'p2' }]) assert.equal((await post('sessions', { hostId: 'host', projectId: 'p1', agent: 'claude', ...extra })).status, 400)
  assert.equal((await post('sessions', { hostId: 'host', projectId: 'p1', agent: 'codex' })).status, 200)
  assert.deepEqual(c.calls.find(call => call.method === 'POST' && call.path === '/api/sessions').body, { agent: 'codex', mode: 'normal', root: '/work' })
  assert.equal((await post('wake', { hostId: 'host', sessionId: SESSION })).status, 200)
  assert.equal((await post('close', { hostId: 'host', sessionId: SESSION })).status, 200)
})
test('actor rotation, host replacement and scope mutation revoke device instead of inheriting desktop identity', async () => {
  for (const mutate of [c => c.binding({ actorId: 'bob', generation: 'two', allowedRoots: ['/work'], operateOthers: false }), c => c.state.hosts[0].target = 'new@host', c => c.state.projects[0].root = '/different', c => c.binding(null)]) {
    const c = fixture(), paired = await c.pair({ input: true })
    mutate(c)
    assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)).status, 401)
    assert.equal(c.gateway.devices().length, 0)
  }
})
test('pair replay, revoked invite identity, malformed body and body bound are rejected', async () => {
  const c = fixture()
  const invitation = await c.gateway.invite({ projectIds: ['p1'] }, 1)
  const body = { invitationCode: invitation.invitationCode, deviceName: 'Pixel' }
  assert.equal((await c.request('/api/v1/pair', 'POST', body)).status, 200)
  assert.equal((await c.request('/api/v1/pair', 'POST', body)).status, 401)
  const next = await c.gateway.invite({ projectIds: ['p1'] }, 1)
  c.binding(null)
  assert.equal((await c.request('/api/v1/pair', 'POST', { ...body, invitationCode: next.invitationCode })).status, 401)
  assert.equal((await c.request('/api/v1/pair', 'POST', '{invalid')).status, 400)
  assert.equal((await c.request('/api/v1/pair', 'POST', JSON.stringify({ huge: 'x'.repeat(4097) }))).status, 400)
})
test('native stream uses bearer headers, sequenced replay, bounded HTTP input and per-device ownership', async () => {
  const c = fixture(), paired = await c.pair({ input: true })
  const client = await c.socket(paired.credential)
  assert.ok(client)
  const ready = client.frames.find(frame => frame.type === 'ready')
  assert.ok(ready.streamId); assert.equal(c.streams.get(ready.streamId).from, 4)
  const post = body => c.request('/api/v1/input', 'POST', body, paired.credential)
  assert.equal((await post({ streamId: ready.streamId, data: Buffer.from('hello').toString('base64') })).status, 200)
  assert.equal(terminalWrites(c).length, 1)
  for (const data of ['a', '@@@@', Buffer.alloc(2049).toString('base64')]) assert.equal((await post({ streamId: ready.streamId, data })).status, 400)
  const another = await c.pair({ input: true })
  assert.equal((await c.request('/api/v1/input', 'POST', { streamId: ready.streamId, data: 'aGk=' }, another.credential)).status, 400)
  assert.equal(await c.socket(paired.credential, SESSION, -1), null)
  assert.equal(await c.socket(paired.credential, SESSION, 0, '&token=forbidden'), null)
  c.gateway.revoke(paired.device.id)
  assert.equal(client.ended, true); assert.equal(c.streams.has(ready.streamId), false)
})
test('stream checks identity before output and closes after host invalidation or backend ownership change', async () => {
  const c = fixture(), paired = await c.pair({ input: true })
  const client = await c.socket(paired.credential)
  const streamId = client.frames[0].streamId
  c.binding(null)
  c.streams.get(streamId).emit({ type: 'output', seq: 5, data: 'SECRET' })
  await new Promise(ok => setImmediate(ok))
  assert.equal(client.ended, true); assert.equal(client.frames.some(frame => frame.data === 'SECRET'), false)
  const other = fixture(), second = await other.pair({ input: true })
  const secondClient = await other.socket(second.credential)
  other.gateway.invalidateHost('host')
  assert.equal(secondClient.ended, true)
})
test('foreground notices expose only visible sessions and allowlisted fields; quotas require grant', async () => {
  const c = fixture(), paired = await c.pair({ quotas: true })
  const notices = await c.request('/api/v1/notices', 'GET', undefined, paired.credential)
  assert.equal(notices.body.length, 1); assert.equal(JSON.stringify(notices.body).includes('SECRET'), false)
  assert.equal((await c.request('/api/v1/quotas', 'GET', undefined, paired.credential)).body[0].label, 'Trabajo')
})
test('existing LAN browser requires origin/cookie and scoped reads survive only until invalidation', async () => {
  const c = fixture()
  c.binding(null)
  const pair = await c.request('/api/pair', 'POST', { code: c.gateway.pairingCode }, undefined, { origin: c.gateway.origin })
  assert.equal(pair.status, 200); assert.match(pair.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict/)
  const headers = { cookie: 'crow_mobile=cookie', origin: c.gateway.origin }
  assert.equal((await c.request('/api/state', 'GET', undefined, undefined, headers)).status, 200)
  assert.equal((await c.request('/api/wake', 'POST', { hostId: 'host', sessionId: SESSION }, undefined, headers)).status, 400)
  c.gateway.invalidateHost('host')
  assert.equal((await c.request('/api/state', 'GET', undefined, undefined, headers)).status, 401)
})
test('identity changing during awaited session listing leaks no old or new actor data', async () => {
  const c = fixture(), paired = await c.pair()
  c.apiHook(() => c.binding({ actorId: 'bob', generation: 'two', allowedRoots: ['/work'], operateOthers: false }))
  const response = await c.request('/api/v1/sessions?hostId=host', 'GET', undefined, paired.credential)
  assert.equal(response.status, 400)
  assert.equal(response.body.id, undefined)
  assert.equal(c.gateway.devices().length, 0)
})
test('pair invitation is consumed once even by concurrent valid requests', async () => {
  const c = fixture(), invitation = await c.gateway.invite({ projectIds: ['p1'] }, 1)
  const result = await Promise.all(['one', 'two'].map(deviceName => c.request('/api/v1/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName })))
  assert.deepEqual(result.map(response => response.status).sort(), [200, 401])
})
test('resize validates dimensions and input denied after ownership changes', async () => {
  const c = fixture(), paired = await c.pair({ input: true }), client = await c.socket(paired.credential)
  const streamId = client.frames[0].streamId
  for (const size of [{ cols: 0, rows: 24 }, { cols: 500.5, rows: 24 }, { cols: 80, rows: 501 }]) assert.equal((await c.request('/api/v1/resize', 'POST', { streamId, ...size }, paired.credential)).status, 400)
  assert.equal((await c.request('/api/v1/resize', 'POST', { streamId, cols: 80, rows: 24 }, paired.credential)).status, 200)
  c.sessions([{ id: SESSION, root: '/work', ownerId: 'bob', readOnly: true }])
  assert.equal((await c.request('/api/v1/input', 'POST', { streamId, data: 'aGk=' }, paired.credential)).status, 400)
  assert.equal(terminalWrites(c, 'input').length, 0)
})
test('output is sequenced, allowlisted and backpressure closes slow consumers', async () => {
  const c = fixture(), paired = await c.pair(), client = await c.socket(paired.credential)
  const streamId = client.frames[0].streamId
  const emit = c.streams.get(streamId).emit
  emit({ type: 'output', seq: 5, data: 'aGk=', token: 'LEAK' }); emit({ type: 'output', seq: 6, data: 'dGhlcmU=' })
  await new Promise(ok => setImmediate(ok))
  assert.deepEqual(client.frames.filter(frame => frame.type === 'output').map(frame => frame.seq), [5, 6])
  assert.equal(JSON.stringify(client.frames).includes('LEAK'), false)
  client.bufferedAmount = 1024 * 1024 + 1
  emit({ type: 'output', seq: 7, data: 'ZA==' })
  assert.equal(client.ended, true)
})

test('chat streams attach at fresh session sequence and ignore output before queue accounting', async () => {
  const c = fixture(), paired = await c.pair()
  const info = { id: SESSION, agent: 'claude', mode: 'normal', ownerId: 'alice', root: '/work', state: 'running', seq: 9000 }
  c.sessions([info])
  const connection = c.gateway.deps.connection('host'), attach = connection.attach
  let pauses = 0
  connection.pauseStream = () => pauses++
  connection.attach = async (id, sessionId, from, emit) => {
    await attach(id, sessionId, from, emit)
    emit({ type: 'output', seq: 9001, data: 'x'.repeat(2 * 1024 * 1024) })
    for (let seq = 9002; seq < 14002; seq++) emit({ type: 'output', seq, data: 'aGk=' })
    emit({ type: 'state', info })
  }
  const client = await c.socket(paired.credential, SESSION, 1, '&mode=chat')
  assert.ok(client)
  assert.equal([...c.streams.values()][0].from, 9000, 'chat ignores the stale caller replay cursor')
  assert.equal(client.ended, false, 'ignored replay exceeds both byte and frame queue limits without closing chat')
  assert.equal(pauses, 0, 'discarded output never pauses upstream')
  assert.equal(client.frames.filter(frame => frame.type === 'state').length, 1)
  assert.equal(client.frames.filter(frame => frame.type === 'ready').length, 1)
  assert.equal(client.frames.some(frame => frame.type === 'output'), false)
  const emit = [...c.streams.values()][0].emit
  emit({ type: 'disconnected' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.frames.at(-1).type, 'disconnected')
  client.bufferedAmount = 1024 * 1024 + 1
  emit({ type: 'output', seq: 14002, data: 'aGk=' })
  assert.equal(client.ended, false, 'output stays ignored even while transport is backpressured')
  emit({ type: 'state', info })
  assert.equal(client.ended, true, 'state retains the existing slow-consumer protection')
})

test('stream modes fail closed while explicit terminal preserves the caller cursor and output', async () => {
  const c = fixture(), paired = await c.pair()
  for (const mode of ['other', '', 'chat&mode=terminal']) {
    assert.equal(await c.socket(paired.credential, SESSION, 1, '&mode=' + mode), null)
  }
  c.sessions([{ id: SESSION, agent: 'claude', mode: 'normal', ownerId: 'alice', root: '/work', state: 'running', seq: -1 }])
  assert.equal(await c.socket(paired.credential, SESSION, 1, '&mode=chat'), null, 'invalid fresh cursor cannot silently replay from zero')
  const client = await c.socket(paired.credential, SESSION, 1, '&mode=terminal')
  assert.ok(client)
  const stream = [...c.streams.values()][0]
  assert.equal(stream.from, 1)
  stream.emit({ type: 'output', seq: 2, data: 'aGk=' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(client.frames.at(-1), { type: 'output', seq: 2, data: 'aGk=' })
})

test('terminal replay bursts pause upstream and render without disconnecting or dropping frames', async () => {
  const c = fixture(), paired = await c.pair({ input: true }), client = await c.socket(paired.credential)
  const stream = [...c.gateway.clients.values()][0]
  let pauses = 0, resumes = 0
  stream.connection.pauseStream = () => pauses++
  stream.connection.resumeStream = () => resumes++
  const emit = c.streams.get(stream.streamId).emit
  for (let seq = 5; seq < 517; seq++) emit({ type: 'output', seq, data: 'aGk=' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.ended, false)
  assert.equal(pauses, 1)
  assert.equal(resumes, 1)
  assert.deepEqual(client.frames.filter(frame => frame.type === 'output').map(frame => frame.seq), Array.from({ length: 512 }, (_, i) => i + 5))
  assert.equal((await c.request('/api/v1/resize', 'POST', { streamId: stream.streamId, cols: 80, rows: 24 }, paired.credential)).status, 200)
  emit({ type: 'output', seq: 517, data: 'x'.repeat(1024 * 1024) })
  assert.equal(client.ended, true, 'byte-based memory limit is still enforced')
})
test('stop cancels invitations and streams but preserves device trust; legacy cookies expire', async () => {
  const c = fixture(), paired = await c.pair(), client = await c.socket(paired.credential)
  await c.gateway.invite({ projectIds: ['p1'] }, 1)
  await c.gateway.stop()
  assert.equal(client.ended, true); assert.equal(c.gateway.status().running, false); assert.equal(c.gateway.devices().length, 1)
  assert.equal(c.gateway.registry.invitation(), undefined)
  assert.equal(c.gateway.registry.authenticate(paired.credential).device.id, paired.device.id)
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)).status, 503)
  const other = fixture()
  other.gateway.pairingCode = ''; other.gateway.cookieExpires = Date.now() - 1
  assert.equal((await other.request('/api/state', 'GET', undefined, undefined, { cookie: 'crow_mobile=cookie' })).status, 401)
  const replaced = fixture()
  replaced.gateway.pairingCode = ''; replaced.state.hosts[0].target = 'new@host'
  assert.equal((await replaced.request('/api/state', 'GET', undefined, undefined, { cookie: 'crow_mobile=cookie' })).status, 401)
})

test('temporary host disconnect suspends access and streams without revoking device trust', async () => {
  const c = fixture(), paired = await c.pair({ input: true, create: true, quotas: true }), client = await c.socket(paired.credential)
  const streamId = client.frames[0].streamId
  c.hostStatus('disconnected'); c.gateway.suspendHost('host')
  c.gateway.deps.snapshot = () => ({ ...c.state, hosts: [], projects: [] }) // Visible workspace disappears while SSH is down.
  assert.equal(client.ended, true)
  for (const path of ['/api/v1/bootstrap', '/api/v1/quotas', '/api/v1/notices']) {
    const response = await c.request(path, 'GET', undefined, paired.credential)
    assert.equal(response.status, 200)
  }
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)).body.projects[0].availability, 'server-disconnected')
  assert.equal((await c.request('/api/v1/input', 'POST', { streamId, data: 'aGk=' }, paired.credential)).status, 503)
  assert.equal((await c.request('/api/v1/sessions', 'POST', { hostId: 'host', projectId: 'p1', agent: 'codex' }, paired.credential)).status, 503)
  assert.equal(c.gateway.devices().length, 1)
  assert.equal(c.calls.some(call => call.stream || call.method === 'POST'), false)
  c.hostStatus('connected')
  c.gateway.deps.snapshot = () => c.state
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)).status, 200)
  assert.ok(await c.socket(paired.credential))
})

test('host availability loss during authorization does not revoke; changed grants after reconnect do', async () => {
  const c = fixture(), paired = await c.pair()
  c.apiHook(() => c.hostStatus('disconnected'))
  const unavailable = await c.request('/api/v1/sessions?hostId=host', 'GET', undefined, paired.credential)
  assert.equal(unavailable.status, 200)
  assert.deepEqual(unavailable.body, [])
  assert.equal(c.gateway.devices().length, 1)
  c.hostStatus('connected'); c.apiHook(() => {})
  c.binding({ actorId: 'alice', generation: 'one', allowedRoots: ['/other'], operateOthers: false })
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)).status, 401)
  assert.equal(c.gateway.devices().length, 0)
})
test('remote access cannot bind publicly or trust arbitrary proxy origins', async () => {
  const c = fixture()
  for (const publicOrigin of ['http://host.ts.net', 'https://evil.invalid', 'https://user:pass@host.ts.net', 'https://host.ts.net/path', 'https://host.ts.net?secret=x', 'https://host.ts.net#secret', 'https://host.ts.net:444']) await assert.rejects(c.gateway.start({ address: '192.168.1.8', publicOrigin }), /Tailscale Serve/)
  await assert.rejects(c.gateway.start({ address: '0.0.0.0' }), /IPv4 privada/)
  const paired = await c.pair()
  assert.equal(paired.endpoints[0].kind, 'lan-pinned'); assert.equal(paired.endpoints[0].certSHA256, 'pin')
  assert.equal(paired.endpoints.some(endpoint => endpoint.url.startsWith('http:')), false)
})

test('Pangolin is explicit, requires a stable port and a pure public HTTPS FQDN', () => {
  const valid = { address: '192.168.1.8', remoteProvider: 'pangolin', publicOrigin: 'https://crow.example.com', loopbackPort: 47323 }
  assert.deepEqual(mobileRemoteConfig(valid), { provider: 'pangolin', origin: valid.publicOrigin, port: 47323 })
  assert.equal(mobileRemoteConfig({ address: valid.address, publicOrigin: 'https://host.ts.net' }).provider, 'tailscale')
  assert.equal(mobileRemoteConfig(valid.address), undefined)
  for (const publicOrigin of ['http://crow.example.com', 'https://localhost', 'https://foo.localhost', 'https://127.0.0.1', 'https://[::1]', 'https://a.123', 'https://*.example.com', 'https://crow.example.com:443', 'https://crow.example.com/path', 'https://user@crow.example.com', 'https://crow.example.com?x=1', 'https://crow.example.com#x', 'https://crow.example.com/../']) assert.throws(() => mobileRemoteConfig({ ...valid, publicOrigin }))
  for (const loopbackPort of [undefined, 0, 1023, 65536, 47323.5, '47323']) assert.throws(() => mobileRemoteConfig({ ...valid, loopbackPort }))
  assert.throws(() => mobileRemoteConfig({ ...valid, remoteProvider: 'unknown' }))
  assert.throws(() => mobileRemoteConfig({ ...valid, publicOrigin: undefined }))
  assert.throws(() => mobileRemoteConfig({ ...valid, remoteProvider: undefined }))
})

test('relay configuration accepts only an exact WSS tunnel endpoint', () => {
  assert.equal(mobileRelayConfig({ address: '192.168.1.8', relayUrl: 'wss://relay.example.com/v1/tunnel' }), 'wss://relay.example.com/v1/tunnel')
  assert.equal(mobileRelayConfig({ address: '192.168.1.8' }), undefined)
  for (const relayUrl of ['ws://relay.example.com/v1/tunnel', 'wss://relay.example.com/', 'wss://user:pass@relay.example.com/v1/tunnel', 'wss://relay.example.com/v1/tunnel?token=x', 'wss://relay.example.com/v1/tunnel#x']) assert.throws(() => mobileRelayConfig({ address: '192.168.1.8', relayUrl }), /WSS exacta/)
})

test('stable loopback bind is exclusive and never silently retries a different port', async () => {
  const server = new EventEmitter(), calls = []
  server.listen = (options) => { calls.push(options); server.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })) }
  await assert.rejects(listenMobileLoopback(server, 47323), /47323.*ocupado/)
  assert.deepEqual(calls, [{ port: 47323, host: '127.0.0.1', exclusive: true }])
  server.listen = (options, ready) => { calls.push(options); ready() }
  await listenMobileLoopback(server, 47324)
  assert.deepEqual(calls[1], { port: 47324, host: '127.0.0.1', exclusive: true })
})

test('real local bind stays loopback and an occupied port is never replaced', async t => {
  const owner = createServer(), other = createServer()
  t.after(async () => { if (owner.listening) await new Promise(ok => owner.close(ok)); if (other.listening) await new Promise(ok => other.close(ok)) })
  await listenMobileLoopback(owner, 0)
  const address = owner.address()
  assert.equal(address.address, '127.0.0.1')
  await assert.rejects(listenMobileLoopback(other, address.port), /ocupado/)
  assert.equal(other.listening, false)
})

test('Pangolin token enters only the one-time QR payload and never status or pending invitation state', async () => {
  const c = fixture()
  c.gateway.endpoints.push({ kind: 'remote-public', url: 'https://crow.example.com', provider: 'pangolin', proxyAuthRequired: true })
  const invite = await c.gateway.invite({ projectIds: ['p1'], pangolinAuth: { tokenId: 'resource-token-id', token: 'resource-secret' } })
  assert.equal(invite.endpoints[1].proxyAuthRequired, true)
  assert.deepEqual(invite.endpoints[1].proxyAuth, { origin: 'https://crow.example.com', tokenId: 'resource-token-id', token: 'resource-secret' })
  assert.doesNotMatch(JSON.stringify(c.gateway.status()), /tokenId|proxyAuth"|P-Access-Token|credential/)
  assert.doesNotMatch(JSON.stringify(c.gateway.registry.invitation()), /resource-token-id|resource-secret/)
  await assert.rejects(c.gateway.invite({ projectIds: ['p1'] }), /Ingresá el ID y el token/)
  await assert.rejects(c.gateway.invite({ projectIds: ['p1'], pangolinAuth: { tokenId: 'bad id', token: 'resource-secret' } }), /sin espacios/)
})

test('v2 enrollment cannot downgrade; signed fresh proof renews only scoped authorization', async () => {
  const c = fixture(), keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const invitation = await c.gateway.invite({ projectIds: ['p1'], capabilities: { input: true } })
  assert.equal(invitation.version, 2)
  assert.equal((await c.request('/api/v1/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Downgrade' })).status, 401)
  const paired = await c.request('/api/v2/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android', publicKey })
  assert.equal(paired.status, 200); assert.equal(paired.body.version, 2); assert.equal(paired.body.device.expiresAt, null)
  const boot = await c.request('/api/v1/bootstrap', 'GET', undefined, paired.body.credential)
  assert.equal(boot.status, 200); assert.equal(boot.body.projects.length, 1)
  assert.equal(JSON.stringify(c.gateway.registry.snapshot()).includes(paired.body.credential), false)
  const id = paired.body.device.id
  const challenge = await c.request('/api/v2/device-challenge', 'POST', { deviceId: id })
  const signature = sign('sha256', mobileAuth.deviceProofPayload(challenge.body), keys.privateKey).toString('base64')
  const proof = { deviceId: id, challengeId: challenge.body.challengeId, signature }
  const renewed = await c.request('/api/v2/device-renew', 'POST', proof)
  assert.equal(renewed.status, 200)
  assert.equal((await c.request('/api/v2/device-renew', 'POST', proof)).status, 401)
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, renewed.body.credential)).status, 200)
  const client = await c.socket(renewed.body.credential)
  const stream = [...c.gateway.clients.values()][0]
  stream.credentialExpiresAt = Date.now() - 1
  await c.gateway.auditStreams()
  assert.equal(client.ended, false, 'v2 trust governs an already authenticated stream, not the bearer lifetime')
  c.hostStatus('disconnected'); c.gateway.suspendHost('host')
  assert.equal((await c.request('/api/v2/device-challenge', 'POST', { deviceId: id })).status, 200)
  assert.equal(c.gateway.devices().length, 1)
  c.hostStatus('connected')
  const again = await c.request('/api/v2/device-challenge', 'POST', { deviceId: id })
  assert.equal(again.status, 200)
  c.binding({ actorId: 'bob', generation: 'two', allowedRoots: ['/work'], operateOthers: false })
  const after = { deviceId: id, challengeId: again.body.challengeId, signature: sign('sha256', mobileAuth.deviceProofPayload(again.body), keys.privateKey).toString('base64') }
  assert.equal((await c.request('/api/v2/device-renew', 'POST', after)).status, 401)
  assert.equal(c.gateway.devices().length, 0)
})

test('v2 terminal survives short bearer expiry, operates once, and closes on revocation or role change', async () => {
  for (const invalidation of ['revoke', 'role']) {
    const c = fixture(), keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const invitation = await c.gateway.invite({ projectIds: ['p1'], capabilities: { input: true } })
    const paired = await c.request('/api/v2/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })
    const client = await c.socket(paired.body.credential), stream = [...c.gateway.clients.values()][0]
    stream.credentialExpiresAt = Date.now() - 1
    for (const token of c.gateway.registry.access.values()) token.expiresAt = Date.now() - 1
    assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.body.credential)).status, 401)
    assert.equal(await c.socket(paired.body.credential), null, 'expired bearer cannot authenticate a new stream')
    await c.gateway.auditStreams()
    assert.equal(client.ended, false)
    c.streams.get(stream.streamId).emit({ type: 'output', seq: 5, data: 'aGk=' })
    client.emit('message', Buffer.from(JSON.stringify({ type: 'input', requestId: randomUUID(), data: 'aGk=' })))
    await new Promise(ok => setImmediate(ok))
    assert.equal(client.frames.some(frame => frame.type === 'output' && frame.seq === 5), true)
    assert.equal(terminalWrites(c, 'input').length, 0, 'expired WS mutation context cannot bypass renewed HTTP authorization')
    assert.equal(client.ended, false, 'reading continues while Android renews its HTTP credential')
    const challenge = await c.request('/api/v2/device-challenge', 'POST', { deviceId: paired.body.device.id })
    const renewed = await c.request('/api/v2/device-renew', 'POST', { deviceId: paired.body.device.id, challengeId: challenge.body.challengeId, signature: sign('sha256', mobileAuth.deviceProofPayload(challenge.body), keys.privateKey).toString('base64') })
    const input = { streamId: stream.streamId, requestId: randomUUID(), data: 'aGk=' }
    assert.equal((await c.request('/api/v1/input', 'POST', input, renewed.body.credential)).status, 200)
    assert.equal(terminalWrites(c, 'input').length, 1, 'Android HTTP mutation is executed once after renewal')
    if (invalidation === 'revoke') c.gateway.revoke(paired.body.device.id)
    else { c.binding({ actorId: 'alice', generation: 'one', allowedRoots: ['/work', '/other'], operateOthers: false, role: 'admin' }); await c.gateway.auditStreams() }
    assert.equal(client.ended, true)
    assert.equal(c.gateway.devices().length, 0)
  }
})

test('legacy v1 streams still close at their original credential/device TTL', async () => {
  const c = fixture(), paired = await c.pair(), client = await c.socket(paired.credential)
  const stream = [...c.gateway.clients.values()][0], record = c.gateway.registry.authenticate(paired.credential)
  assert.equal(record.publicKey, undefined)
  record.device.expiresAt = new Date(Date.now() - 1).toISOString()
  stream.credentialExpiresAt = Date.now() - 1
  await c.gateway.auditStreams()
  assert.equal(client.ended, true)
  assert.equal(c.gateway.registry.authenticate(paired.credential), undefined)
})

test('v2 pause clears short credentials/challenges without revoking key trust', async () => {
  const c = fixture(), keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const invitation = await c.gateway.invite({ projectIds: ['p1'] })
  const paired = await c.request('/api/v2/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })
  const challenge = await c.request('/api/v2/device-challenge', 'POST', { deviceId: paired.body.device.id })
  await c.gateway.stop()
  assert.equal(c.gateway.registry.authenticate(paired.body.credential), undefined)
  assert.equal(c.gateway.devices().length, 1)
  const signature = sign('sha256', mobileAuth.deviceProofPayload(challenge.body), keys.privateKey).toString('base64')
  assert.throws(() => c.gateway.registry.prove(paired.body.device.id, challenge.body.challengeId, signature))
})

test('v2 role promotion/demotion with unchanged actor and roots revokes trust rather than inheriting visibility', async () => {
  for (const [before, after] of [['member', 'admin'], ['admin', 'member']]) {
    const c = fixture(), keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const binding = { actorId: 'alice', generation: 'one', allowedRoots: ['/work', '/other'], operateOthers: false }
    c.binding({ ...binding, role: before })
    const invitation = await c.gateway.invite({ projectIds: ['p1'] })
    const paired = await c.request('/api/v2/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })
    c.binding({ ...binding, role: after })
    assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.body.credential)).status, 401)
    assert.equal(c.gateway.devices().length, 0)
  }
})

async function keyFixture() {
  const c = fixture(), keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const invitation = await c.gateway.invite({ projectIds: ['p1'], capabilities: { input: true, create: true, close: true } })
  const paired = await c.request('/api/v2/pair', 'POST', { invitationCode: invitation.invitationCode, deviceName: 'Android', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })
  return { ...c, credential: paired.body.credential }
}
test('mobile input waits for remote PTY acknowledgement and never silently falls back to a queued WebSocket write', async () => {
  const c = await keyFixture(), client = await c.socket(c.credential), streamId = client.frames[0].streamId
  let release
  const gate = new Promise(ok => { release = ok })
  c.apiHook(async (method, path) => { if (method === 'POST' && path.endsWith('/input')) await gate })
  const body = { streamId, requestId: randomUUID(), data: 'aGk=' }
  let resolved = false
  const pending = c.request('/api/v1/input', 'POST', body, c.credential).then(result => { resolved = true; return result })
  await new Promise(ok => setImmediate(ok))
  assert.equal(resolved, false)
  assert.equal(c.calls.filter(call => call.path === `/api/sessions/${SESSION}/input`).length, 1)
  assert.equal(c.calls.filter(call => call.stream).length, 0)
  release()
  assert.equal((await pending).status, 200)
  assert.equal((await c.request('/api/v1/input', 'POST', body, c.credential)).status, 200)
  assert.equal(terminalWrites(c).length, 1)

  c.apiHook(method => { if (method === 'POST') throw new Error('PTY acknowledgement lost') })
  const uncertain = { ...body, requestId: randomUUID() }
  assert.equal((await c.request('/api/v1/input', 'POST', uncertain, c.credential)).status, 502)
  assert.equal((await c.request('/api/v1/input', 'POST', uncertain, c.credential)).status, 502)
  assert.equal(terminalWrites(c).length, 2, 'unknown operations must not be retried or sent again through WebSocket')
})
test('all HTTP v2 mutations require requestId and replay the same result without reexecution', async () => {
  for (const route of ['sessions', 'wake', 'close', 'input', 'resize']) {
    const c = await keyFixture(), client = await c.socket(c.credential), streamId = client.frames[0].streamId
    const body = route === 'sessions' ? { hostId: 'host', projectId: 'p1', agent: 'codex' } : route === 'input' ? { streamId, data: 'aGk=' } : route === 'resize' ? { streamId, cols: 80, rows: 24 } : { hostId: 'host', sessionId: SESSION }
    assert.equal((await c.request(`/api/v1/${route}`, 'POST', body, c.credential)).status, 400)
    const input = { ...body, requestId: randomUUID() }
    const results = await Promise.all([c.request(`/api/v1/${route}`, 'POST', input, c.credential), c.request(`/api/v1/${route}`, 'POST', input, c.credential)])
    assert.equal(results[0].status, 200); assert.deepEqual(results[0].body, results[1].body)
    if (route === 'close') c.sessions([]) // The original session may already be gone on replay.
    const replay = await c.request(`/api/v1/${route}`, 'POST', input, c.credential)
    assert.equal(replay.status, 200); assert.deepEqual(replay.body, results[0].body)
    assert.equal(c.calls.filter(call => call.stream || call.method === 'POST' || call.method === 'DELETE').length, 1)
    assert.equal((await c.request(`/api/v1/${route}`, 'POST', { ...input, extra: 'changed' }, c.credential)).status, 409)
  }
})
test('HTTP v2 ambiguous execution caches a tombstone rather than retrying the operation', async () => {
  const c = await keyFixture()
  c.apiHook(method => { if (method === 'POST') throw new Error('uncertain private failure') })
  const body = { hostId: 'host', projectId: 'p1', agent: 'claude', requestId: randomUUID() }
  const first = await c.request('/api/v1/sessions', 'POST', body, c.credential)
  assert.equal(first.status, 502)
  const replay = await c.request('/api/v1/sessions', 'POST', body, c.credential)
  assert.deepEqual(replay.body, first.body); assert.equal(replay.status, 502)
  assert.equal(c.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(JSON.stringify(first.body).includes('private failure'), false)
})
test('WS v2 uses the same contextual ledger, including missing IDs, concurrent replay and HTTP replay', async () => {
  const c = await keyFixture(), client = await c.socket(c.credential), streamId = client.frames[0].streamId
  const send = frame => client.emit('message', Buffer.from(JSON.stringify(frame)))
  send({ type: 'input', data: 'aGk=' }); await new Promise(ok => setImmediate(ok))
  assert.equal(terminalWrites(c).length, 0)
  assert.equal(client.ended, false)
  assert.equal(client.frames.some(frame => frame.type === 'mutation-result' && frame.status === 400), true)
  const requestId = randomUUID(), frame = { type: 'input', requestId, data: 'aGk=' }
  send(frame); send(frame); await new Promise(ok => setImmediate(ok))
  assert.equal(terminalWrites(c).length, 1)
  const replay = await c.request('/api/v1/input', 'POST', { requestId, streamId, data: 'aGk=' }, c.credential)
  assert.equal(replay.status, 200); assert.equal(terminalWrites(c).length, 1)
  send({ ...frame, data: 'd3Jvbmc=' }); await new Promise(ok => setImmediate(ok))
  assert.equal(client.frames.some(value => value.type === 'mutation-result' && value.status === 409), true)
  assert.equal(terminalWrites(c).length, 1)
})
test('bootstrap advertises gateway support separately from per-device grants', async () => {
  const c = fixture(), paired = await c.pair()
  const boot = await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)
  assert.deepEqual(boot.body.supportedFeatures, {
    sessionList: true,
    terminalStream: true,
    terminalInput: true,
    sessionCreate: true,
    sessionWake: true,
    sessionClose: true,
    notices: true,
    quotas: true,
    pushNotifications: false,
    structuredChat: true,
    approvalActions: false,
    fileBrowser: false,
    gitStatus: false,
  })
  assert.deepEqual(boot.body.device.capabilities, { input: false, create: false, close: false, quotas: false })
  const granted = await c.pair({ input: true, create: true, close: true, quotas: true })
  const grantedBoot = await c.request('/api/v1/bootstrap', 'GET', undefined, granted.credential)
  assert.deepEqual(grantedBoot.body.supportedFeatures, boot.body.supportedFeatures)
  assert.deepEqual(grantedBoot.body.device.capabilities, { input: true, create: true, close: true, quotas: true })
})

test('native errors expose stable codes without changing their HTTP status or message', async () => {
  const c = fixture()
  const origin = await c.request('/api/v1/bootstrap', 'GET', undefined, undefined, { origin: 'https://attacker.invalid' })
  assert.equal(origin.status, 403)
  assert.equal(origin.body.error, 'Origen inválido.')
  assert.equal(origin.body.code, 'INVALID_ORIGIN')

  const unavailable = fixture()
  await unavailable.gateway.stop()
  const paused = await unavailable.request('/api/v1/bootstrap')
  assert.equal(paused.status, 503)
  assert.equal(paused.body.error, 'Gateway pausado.')
  assert.equal(paused.body.code, 'GATEWAY_UNAVAILABLE')

  const paired = await c.pair()
  const rejected = await c.request('/api/v1/bootstrap', 'GET', undefined, 'f'.repeat(64))
  assert.equal(rejected.status, 401)
  assert.equal(rejected.body.error, 'Dispositivo revocado o identidad modificada. Volvé a emparejar.')
  assert.equal(rejected.body.code, 'DEVICE_REJECTED')

  c.hostStatus('disconnected')
  const hostDown = await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)
  assert.equal(hostDown.status, 200)
  assert.equal(hostDown.body.hosts[0].status, 'disconnected')
  assert.equal(hostDown.body.projects[0].availability, 'server-disconnected')
  c.hostStatus('connected')

  const grant = await c.request('/api/v1/quotas', 'GET', undefined, paired.credential)
  assert.equal(grant.status, 403)
  assert.equal(grant.body.error, 'Cuotas no habilitadas para este dispositivo.')
  assert.equal(grant.body.code, 'GRANT_REQUIRED')

  const writeGrant = await c.request('/api/v1/sessions', 'POST', { hostId: 'host', projectId: 'p1', agent: 'claude' }, paired.credential)
  assert.equal(writeGrant.status, 403)
  assert.equal(writeGrant.body.error, 'Creación no habilitada.')
  assert.equal(writeGrant.body.code, 'GRANT_REQUIRED')

  const missing = await c.request('/api/v1/does-not-exist', 'GET', undefined, paired.credential)
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'Ruta no encontrada.')
  assert.equal(missing.body.code, 'NOT_FOUND')

  const malformed = await c.request('/api/v1/input', 'POST', '{invalid', paired.credential)
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.error, 'Solicitud rechazada. Revisá el emparejamiento y los permisos.')
  assert.equal(malformed.body.code, 'INVALID_REQUEST')
})
