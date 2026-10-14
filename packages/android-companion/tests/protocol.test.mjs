import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEnrollment, OutputCursor, encodeInput, decodeOutput, mayOperate, mayWake, staleQuota, agentLabel, sessionStateLabel, quotaStateLabel } from '../src/protocol.mjs'
const valid = () => ({ version: 2, gatewayId: 'gateway-test', invitationCode: 'one-use', expiresAt: '2099-01-01T00:00:00Z', endpoints: [{ kind: 'lan-pinned', url: 'https://192.168.1.10:9841', certSHA256: Array(32).fill('AB').join(':') }] })

test('Pangolin metadata requests native authentication, never accepts resource secrets in QR', () => {
  const endpoint = { kind: 'remote-public', url: 'https://crow.example.com', provider: 'pangolin', proxyAuthRequired: true }
  const enrollment = updates => JSON.stringify({ ...valid(), endpoints: [{ ...endpoint, ...updates }] })
  assert.equal(parseEnrollment(enrollment({})).endpoints[0].proxyAuthRequired, true)
  for (const changes of [{ proxyAuthRequired: false }, { proxyAuthRequired: 'true' }, { provider: 'unknown' }, { kind: 'lan-pinned', certSHA256: valid().endpoints[0].certSHA256 }, { url: 'https://crow.example.com:443' }, { url: 'https://127.0.0.1' }, { token: 'fake' }, { tokenId: 'fake' }, { proxyAuth: {} }]) assert.throws(() => parseEnrollment(enrollment(changes)))
  assert.throws(() => parseEnrollment(JSON.stringify({ ...valid(), proxyAuth: { token: 'fake' } })))
})
test('new links require valid future v2 invitations; old QR requires explicit Windows regeneration', () => {
  assert.equal(parseEnrollment(JSON.stringify(valid())).gatewayId, 'gateway-test')
  assert.equal(parseEnrollment(JSON.stringify(valid())).version, 2)
  assert.throws(() => parseEnrollment(JSON.stringify({ ...valid(), version: 1 })), /Actualizá Crow en Windows.*nuevo QR/)
  for (const update of [{ version: 3 }, { expiresAt: '2000-01-01' }, { invitationCode: '' }, { endpoints: [] }]) assert.throws(() => parseEnrollment(JSON.stringify({ ...valid(), ...update })))
})
test('endpoint disallows insecure schemes, userinfo and URL smuggling', () => {
  for (const url of ['http://crow.test', 'https://user:secret@crow.test', 'https://crow.test/path', 'https://crow.test/?code=secret', 'https://crow.test/#token', 'https://crow.test:99999', 'https://crow.test/%2e%2e/input']) assert.throws(() => parseEnrollment(JSON.stringify({ ...valid(), endpoints: [{ ...valid().endpoints[0], url }] })))
  assert.throws(() => parseEnrollment(JSON.stringify({ ...valid(), endpoints: [{ kind: 'lan-pinned', url: 'https://crow.test', certSHA256: 'bad' }] })))
})
test('remote public origin relies on CA and permits no LAN missing pin', () => { assert.equal(parseEnrollment(JSON.stringify({ ...valid(), endpoints: [{ kind: 'remote-public', url: 'https://crow.tailnet.test' }] })).endpoints[0].kind, 'remote-public') })
test('relay endpoint requires a local pinned TLS origin and a canonical-shaped opaque route', () => {
  const endpoint = { kind: 'relay', url: 'https://127.0.0.1:48481', certSHA256: Array(32).fill('AB').join(':'), relayUrl: 'wss://relay.example.com/v1/tunnel', relayRoute: 'A'.repeat(43) }
  assert.equal(parseEnrollment(JSON.stringify({ ...valid(), endpoints: [endpoint] })).endpoints[0].kind, 'relay')
  for (const changes of [{ url: 'https://crow.example.com:48481' }, { relayUrl: 'https://relay.example.com/v1/tunnel' }, { relayUrl: 'wss://relay.example.com/path' }, { relayRoute: 'short' }, { relayRoute: `${'A'.repeat(42)}B` }, { token: 'secret' }]) assert.throws(() => parseEnrollment(JSON.stringify({ ...valid(), endpoints: [{ ...endpoint, ...changes }] })))
})
test('terminal resumes strictly monotonic output without replaying input', () => {
  const cursor = new OutputCursor()
  assert.equal(cursor.accept({ type: 'output', seq: 5, data: 'YQ==' }), true)
  for (const frame of [{ type: 'output', seq: 5, data: 'YQ==' }, { type: 'output', seq: 2, data: 'YQ==' }, { type: 'ready', seq: 6 }, { type: 'output', seq: NaN, data: 'YQ==' }]) assert.equal(cursor.accept(frame), false)
  assert.equal(cursor.accept({ type: 'output', seq: 7, data: 'Yg==' }), true); assert.equal(cursor.seq, 7)
})
test('terminal output cursor distinguishes contiguous frames, gaps, and duplicate or old frames', () => {
  const cursor = new OutputCursor()
  assert.equal(cursor.accept({ type: 'output', seq: 1, data: 'YQ==' }), true)
  assert.equal(cursor.lastGap, false)
  assert.equal(cursor.accept({ type: 'output', seq: 2, data: 'Yg==' }), true)
  assert.equal(cursor.lastGap, false)
  assert.equal(cursor.accept({ type: 'output', seq: 5, data: 'Yw==' }), true)
  assert.equal(cursor.lastGap, true)
  for (const seq of [5, 3]) {
    assert.equal(cursor.accept({ type: 'output', seq, data: 'ZA==' }), false)
    assert.equal(cursor.lastGap, false)
  }
  assert.equal(cursor.accept({ type: 'output', seq: 6, data: 'ZQ==' }), true)
  assert.equal(cursor.lastGap, false)
  assert.equal(cursor.accept({ type: 'output', seq: 9, data: 'Zg==' }), true)
  assert.equal(cursor.lastGap, true, 'a later distinct gap is detected too')
  assert.equal(cursor.seq, 9)
})
test('first available output reveals history already missing from a bounded replay buffer', () => {
  const cursor = new OutputCursor()
  assert.equal(cursor.accept({ type: 'output', seq: 12, data: 'YQ==' }), true)
  assert.equal(cursor.lastGap, true)
  assert.equal(cursor.seq, 12, 'continue from the newest available output; do not attempt a resync')
})
test('UTF8 terminal bytes survive without lossy text decoding', () => { const value = 'hola ñ 🚀\u001b[31m\r'; assert.equal(new TextDecoder().decode(decodeOutput(encodeInput(value))), value) })
test('input hard limit applies to UTF8 bytes without automatic chunks', () => { assert.equal(decodeOutput(encodeInput('a'.repeat(2048))).length, 2048); assert.throws(() => encodeInput('a'.repeat(2049)), /2048 bytes/); assert.throws(() => encodeInput('🚀'.repeat(513)), /2048 bytes/) })
test('foreign/read-only terminal is fail closed despite device grant', () => { const device = { capabilities: { input: true } }; assert.equal(mayOperate({ canOperate: true }, device), true); assert.equal(mayOperate({ canOperate: true, readOnly: true }, device), false); assert.equal(mayOperate({ canOperate: false }, device), false); assert.equal(mayOperate({}, device), false); assert.equal(mayOperate({ canOperate: true }, { capabilities: { input: false } }), false) })
test('missing quota sample is unavailable/stale, not invented 0%', () => { assert.equal(staleQuota(null), true); assert.equal(staleQuota('invalid'), true); assert.equal(staleQuota(new Date(Date.now() - 600000).toISOString()), true); assert.equal(staleQuota(new Date().toISOString()), false) })
test('close-only device cannot wake or send despite canOperate=true', () => { const session = { canOperate: true, state: 'sleeping' }; const device = { capabilities: { close: true, input: false } }; assert.equal(mayWake(session, device), false); assert.equal(mayOperate(session, device), false); assert.equal(mayWake(session, { capabilities: { input: true } }), true) })
test('production states/brands are Spanish and brand-cased, without raw unknown values', () => { assert.equal(agentLabel('claude'), 'Claude'); assert.equal(agentLabel('codex'), 'Codex'); assert.equal(sessionStateLabel('sleeping'), 'Suspendida'); assert.equal(quotaStateLabel('ready'), 'Actualizada'); assert.equal(quotaStateLabel('stale'), 'Desactualizada'); assert.equal(quotaStateLabel('new-unknown-state'), 'Estado no disponible') })
