import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const ts = path => stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'), { mode: 'transform' })
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const registryURL = dataURL(ts('../src/main/mobile-device-auth.ts'))
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
  .replace("from './mobile-device-auth'", `from '${registryURL}'`)
const { MobileGateway } = await import(dataURL(source))
const SESSION = 'a'.repeat(32), FOREIGN = 'b'.repeat(32), OUTSIDE = 'c'.repeat(32)
function fixture() {
  const state = { hosts: [{ id: 'host', name: 'Windows', target: 'user@mock', port: 22, remotePort: 47000 }], projects: [{ id: 'p1', hostId: 'host', name: 'Work', root: '/work' }, { id: 'p2', hostId: 'host', name: 'Other', root: '/other' }], sessionNames: {}, notices: [] }
  let binding = { actorId: 'alice', generation: 'one', allowedRoots: ['/work', '/other'], operateOthers: false }
  let sessions = [
    { id: SESSION, agent: 'claude', mode: 'normal', ownerId: 'alice', root: '/work', state: 'running', seq: 4, startedAt: 'now', updatedAt: 'now' },
    { id: FOREIGN, agent: 'codex', mode: 'normal', ownerId: 'bob', root: '/work', state: 'running', seq: 4, startedAt: 'now', updatedAt: 'now', readOnly: true },
    { id: OUTSIDE, agent: 'codex', mode: 'normal', ownerId: 'alice', root: '/other', state: 'running', seq: 4, startedAt: 'now', updatedAt: 'now' }
  ]
  const calls = [], streams = new Map()
  let apiHook = () => {}
  const connection = {
    status: () => 'connected',
    api: async (method, path, body) => {
      calls.push({ method, path, body })
      apiHook(method, path, body)
      if (method === 'GET') return structuredClone(sessions)
      if (method === 'DELETE') return {}
      return { ...sessions[0], root: body?.root || sessions[0].root }
    },
    attach: async (id, _session, from, emit) => { streams.set(id, { emit, from }) },
    detach: id => streams.delete(id),
    send: (id, body) => calls.push({ stream: id, body })
  }
  const gateway = new MobileGateway({ snapshot: () => state, connection: () => connection, authSnapshot: async () => { if (!binding) throw new Error('legacy'); return structuredClone(binding) }, quotas: () => [{ id: 'safe', label: 'Trabajo', provider: 'claude', state: 'ready', windows: [], sampledAt: null }], notices: () => [{ id: 'event', hostId: 'host', sessionId: SESSION, kind: 'turn-complete', at: 'now', message: 'SECRET', classification: { detail: 'SECRET' } }, { id: 'hidden', hostId: 'host', sessionId: OUTSIDE, kind: 'turn-complete', at: 'now' }] })
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
    const invitation = await gateway.invite({ projectIds: ['p1'], capabilities })
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
  return { state, gateway, calls, streams, request, pair, socket, binding: value => binding = value, sessions: value => sessions = value, apiHook: value => apiHook = value }
}
test('native pairing and bootstrap expose scoped DTOs, not reusable QR tokens or roots', async () => {
  const c = fixture(), paired = await c.pair()
  const boot = await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential)
  assert.equal(boot.status, 200); assert.equal(boot.body.projects.length, 1); assert.equal(boot.body.projects[0].root, undefined)
  assert.equal(boot.body.devices[0].id, paired.device.id)
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, undefined, { cookie: 'crow_mobile=cookie' })).status, 401)
  assert.equal((await c.request('/api/v1/bootstrap', 'GET', undefined, paired.credential, { origin: 'https://attacker.invalid' })).status, 403)
  assert.equal((await c.request('/api/state', 'GET', undefined, paired.credential, {}, true)).status, 404)
})
test('read-only enrollment denies create/wake/close/quotas and returns foreign sessions readonly', async () => {
  const c = fixture(), paired = await c.pair()
  const result = await c.request('/api/v1/sessions?hostId=host', 'GET', undefined, paired.credential)
  assert.equal(result.body.length, 2); assert.equal(result.body.find(s => s.id === FOREIGN).canOperate, false)
  assert.equal(result.body[0].root, undefined); assert.equal(result.body[0].promptCache, undefined)
  for (const route of ['wake', 'close']) assert.equal((await c.request(`/api/v1/${route}`, 'POST', { hostId: 'host', sessionId: SESSION }, paired.credential)).status, 403)
  assert.equal((await c.request('/api/v1/sessions', 'POST', { hostId: 'host', projectId: 'p1', agent: 'claude' }, paired.credential)).status, 403)
  assert.equal((await c.request('/api/v1/quotas', 'GET', undefined, paired.credential)).status, 403)
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
  const invitation = await c.gateway.invite({ projectIds: ['p1'] })
  const body = { invitationCode: invitation.invitationCode, deviceName: 'Pixel' }
  assert.equal((await c.request('/api/v1/pair', 'POST', body)).status, 200)
  assert.equal((await c.request('/api/v1/pair', 'POST', body)).status, 401)
  const next = await c.gateway.invite({ projectIds: ['p1'] })
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
  assert.equal(c.calls.filter(call => call.stream).length, 1)
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
  const c = fixture(), invitation = await c.gateway.invite({ projectIds: ['p1'] })
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
  assert.equal(c.calls.filter(call => call.stream && call.body.type === 'input').length, 0)
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
test('stop and expired legacy cookies revoke credentials, invitations and active streams', async () => {
  const c = fixture(), paired = await c.pair(), client = await c.socket(paired.credential)
  await c.gateway.invite({ projectIds: ['p1'] })
  await c.gateway.stop()
  assert.equal(client.ended, true); assert.deepEqual(c.gateway.status(), { running: false }); assert.equal(c.gateway.devices().length, 0)
  const other = fixture()
  other.gateway.pairingCode = ''; other.gateway.cookieExpires = Date.now() - 1
  assert.equal((await other.request('/api/state', 'GET', undefined, undefined, { cookie: 'crow_mobile=cookie' })).status, 401)
  const replaced = fixture()
  replaced.gateway.pairingCode = ''; replaced.state.hosts[0].target = 'new@host'
  assert.equal((await replaced.request('/api/state', 'GET', undefined, undefined, { cookie: 'crow_mobile=cookie' })).status, 401)
})
test('remote access cannot bind publicly or trust arbitrary proxy origins', async () => {
  const c = fixture()
  for (const publicOrigin of ['http://host.ts.net', 'https://evil.invalid', 'https://user:pass@host.ts.net', 'https://host.ts.net/path', 'https://host.ts.net?secret=x', 'https://host.ts.net#secret', 'https://host.ts.net:444']) await assert.rejects(c.gateway.start({ address: '192.168.1.8', publicOrigin }), /Tailscale Serve/)
  await assert.rejects(c.gateway.start({ address: '0.0.0.0' }), /IPv4 privada/)
  const paired = await c.pair()
  assert.equal(paired.endpoints[0].kind, 'lan-pinned'); assert.equal(paired.endpoints[0].certSHA256, 'pin')
  assert.equal(paired.endpoints.some(endpoint => endpoint.url.startsWith('http:')), false)
})
