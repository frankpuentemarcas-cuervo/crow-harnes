import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/main/mobile-device-auth.ts', import.meta.url), 'utf8')
const { MobileDeviceRegistry, READ_CAPABILITIES, INVITATION_TTL, DEVICE_TTL } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'))
const scope = { projectId: 'project', hostId: 'host', root: '/work', hostDigest: 'target', binding: { actorId: 'alice', generation: 'one', allowedRoots: ['/work'], operateOthers: false } }
function setup() {
  let time = 1_800_000_000_000
  const registry = new MobileDeviceRegistry(() => time)
  const invite = () => registry.invite({ version: 1, gatewayId: 'gateway', endpoints: [{ kind: 'lan-pinned', url: 'https://192.168.1.8:4000', certSHA256: 'pin' }] }, [scope], READ_CAPABILITIES)
  return { registry, invite, advance: ms => time += ms }
}
test('pairing stores only hashed bearer, single-use code and read-only scoped device', () => {
  const { registry, invite } = setup()
  const enrollment = invite()
  assert.equal(JSON.stringify(enrollment).includes('credential'), false)
  const { credential, record } = registry.pair(enrollment.invitationCode, 'Android')
  assert.match(credential, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(record).includes(credential), false)
  assert.deepEqual(record.device.capabilities, READ_CAPABILITIES)
  assert.deepEqual(record.device.projectIds, ['project'])
  assert.equal(registry.authenticate(credential), record)
  assert.throws(() => registry.pair(enrollment.invitationCode, 'Replay'))
  assert.equal(registry.authenticate(credential.toUpperCase()), undefined)
})
test('invitation and credential TTL, per-device revoke, stop and host invalidation fail closed', () => {
  const c = setup()
  const enrollment = c.invite()
  c.advance(INVITATION_TTL)
  assert.throws(() => c.registry.pair(enrollment.invitationCode, 'Android'))
  let paired = c.registry.pair(c.invite().invitationCode, 'Android')
  c.advance(DEVICE_TTL)
  assert.equal(c.registry.authenticate(paired.credential), undefined)
  paired = c.registry.pair(c.invite().invitationCode, 'Android')
  c.registry.revoke(paired.record.device.id)
  assert.equal(c.registry.authenticate(paired.credential), undefined)
  paired = c.registry.pair(c.invite().invitationCode, 'Android')
  assert.deepEqual(c.registry.invalidateHost('host'), [paired.record.device.id])
  assert.equal(c.registry.authenticate(paired.credential), undefined)
  paired = c.registry.pair(c.invite().invitationCode, 'Android')
  c.registry.clear()
  assert.equal(c.registry.authenticate(paired.credential), undefined)
})
test('pairing rate limits expired windows correctly and guards malformed labels', () => {
  const c = setup()
  const enrollment = c.invite()
  for (let i = 0; i < 5; i++) assert.throws(() => c.registry.candidate('wrong', 'ip'), /Código/)
  assert.throws(() => c.registry.candidate(enrollment.invitationCode, 'ip'), /RATE_LIMIT/)
  assert.doesNotThrow(() => c.registry.candidate(enrollment.invitationCode, 'other'))
  assert.throws(() => c.registry.pair(enrollment.invitationCode, 'bad\nlabel'))
  assert.doesNotThrow(() => c.registry.pair(enrollment.invitationCode, 'Valid'))
})
