import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
const source = stripTypeScriptTypes(readFileSync(new URL('../src/main/mobile-device-auth.ts', import.meta.url), 'utf8'), { mode: 'transform' })
const { MobileDeviceRegistry, READ_CAPABILITIES, ACCESS_TTL, CHALLENGE_TTL, DEVICE_TTL, devicePublicKey, deviceProofPayload } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const key = curve => { const pair = generateKeyPairSync('ec', { namedCurve: curve || 'prime256v1' }); return { ...pair, encoded: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') } }
const scope = { projectId: 'project', hostId: 'host', root: '/work', hostDigest: 'a'.repeat(64), binding: { actorId: 'alice', generation: 'epoch:2', allowedRoots: ['/work'], operateOthers: false, role: 'member' } }
function fixture() {
  let now = 1_800_000_000_000, saved = []
  const create = () => new MobileDeviceRegistry(() => now, saved, records => saved = structuredClone(records))
  const registry = create(), keys = key()
  const invite = () => registry.invite({ version: 2, gatewayId: 'gateway', endpoints: [] }, [scope], READ_CAPABILITIES)
  const paired = registry.pairKey(invite().invitationCode, 'Android', keys.encoded)
  const proof = (challenge, privateKey = keys.privateKey) => sign('sha256', deviceProofPayload(challenge), privateKey).toString('base64')
  return { registry, keys, paired, proof, create, invite, advance: ms => now += ms, snapshot: () => saved }
}
test('device trust outlives legacy TTL but bearer lasts only 15 minutes and is never persisted', () => {
  const f = fixture(), id = f.paired.record.device.id
  assert.equal(f.paired.record.device.expiresAt, null)
  assert.equal(f.registry.authenticate(f.paired.credential).device.id, id)
  assert.equal(JSON.stringify(f.snapshot()).includes(f.paired.credential), false)
  assert.equal(f.snapshot()[0].tokenHash, '')
  f.advance(ACCESS_TTL)
  assert.equal(f.registry.authenticate(f.paired.credential), undefined)
  f.advance(DEVICE_TTL)
  assert.equal(f.registry.keyDevice(id).device.id, id)
  const challenge = f.registry.challenge(id, 'gateway', 'ip')
  assert.equal(challenge.nonce.length, 64)
  const record = f.registry.prove(id, challenge.challengeId, f.proof(challenge))
  const renewed = f.registry.issueCredential(record)
  assert.equal(f.registry.authenticate(renewed.credential).device.id, id)
  assert.throws(() => f.registry.prove(id, challenge.challengeId, f.proof(challenge)))
})
test('fresh proof is required after restart and revocation remains durable', () => {
  const f = fixture(), id = f.paired.record.device.id
  const old = f.registry.challenge(id, 'gateway', 'ip'), restarted = f.create()
  assert.equal(restarted.authenticate(f.paired.credential), undefined)
  assert.throws(() => restarted.prove(id, old.challengeId, f.proof(old)))
  const fresh = restarted.challenge(id, 'gateway', 'ip')
  const renewed = restarted.issueCredential(restarted.prove(id, fresh.challengeId, f.proof(fresh)))
  assert.equal(restarted.authenticate(renewed.credential).device.id, id)
  restarted.revoke(id)
  assert.equal(restarted.authenticate(renewed.credential), undefined)
  assert.throws(() => f.create().challenge(id, 'gateway', 'ip'))
})
test('expired, foreign, corrupted or malformed proofs are consumed and cannot be replayed', () => {
  for (const corrupt of [challenge => ({ ...challenge, gatewayId: 'other-gateway' }), challenge => ({ ...challenge, deviceId: 'other-device' }), challenge => ({ ...challenge, nonce: '0'.repeat(64) })]) {
    const f = fixture(), id = f.paired.record.device.id, challenge = f.registry.challenge(id, 'gateway', 'ip')
    assert.throws(() => f.registry.prove(id, challenge.challengeId, f.proof(corrupt(challenge))))
    assert.throws(() => f.registry.prove(id, challenge.challengeId, f.proof(challenge)))
  }
  const f = fixture(), id = f.paired.record.device.id
  let challenge = f.registry.challenge(id, 'gateway', 'ip')
  assert.throws(() => f.registry.prove(id, challenge.challengeId, f.proof(challenge, key().privateKey)))
  challenge = f.registry.challenge(id, 'gateway', 'ip'); f.advance(CHALLENGE_TTL)
  assert.throws(() => f.registry.prove(id, challenge.challengeId, f.proof(challenge)))
  for (const signature of ['@@@@', '', 'a'.repeat(113), Buffer.from('bad DER').toString('base64')]) {
    challenge = f.registry.challenge(id, 'gateway', 'ip')
    assert.throws(() => f.registry.prove(id, challenge.challengeId, signature))
  }
})
test('only exact canonical P-256 SPKI accepted, with explicit v1/v2 pairing separation', () => {
  const f = fixture()
  assert.equal(devicePublicKey(f.keys.encoded).asymmetricKeyType, 'ec')
  for (const encoded of [key('secp384r1').encoded, Buffer.concat([Buffer.from(f.keys.encoded, 'base64'), Buffer.from([0])]).toString('base64'), f.keys.encoded + '\n', Buffer.alloc(91).toString('base64')]) assert.throws(() => devicePublicKey(encoded))
  const v2 = f.invite()
  assert.throws(() => f.registry.pair(v2.invitationCode, 'Downgrade'))
  assert.throws(() => f.registry.pairKey(v2.invitationCode, 'Replay', f.keys.encoded))
  const old = f.registry.invite({ version: 1, gatewayId: 'gateway', endpoints: [] }, [scope], READ_CAPABILITIES)
  assert.throws(() => f.registry.pairKey(old.invitationCode, 'Upgrade', key().encoded))
  const legacy = f.registry.pair(old.invitationCode, 'Old Android')
  assert.equal(typeof legacy.record.device.expiresAt, 'string')
  assert.throws(() => f.registry.challenge(legacy.record.device.id, 'gateway', 'ip'))
})
test('challenge resource bounds and host invalidation revoke key-based trust', () => {
  const f = fixture(), id = f.paired.record.device.id
  for (let i = 0; i < 10; i++) f.registry.challenge(id, 'gateway', 'ip')
  assert.throws(() => f.registry.challenge(id, 'gateway', 'ip'), /RATE_LIMIT/)
  f.advance(60_000)
  for (let i = 0; i < 64; i++) f.registry.challenge(id, 'gateway', `ip${i}`)
  assert.throws(() => f.registry.challenge(id, 'gateway', 'new'), /RATE_LIMIT/)
  f.registry.invalidateHost('host')
  assert.equal(f.registry.authenticate(f.paired.credential), undefined)
  assert.throws(() => f.create().challenge(id, 'gateway', 'fresh'))
})
