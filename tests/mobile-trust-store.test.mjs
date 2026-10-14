import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const registryURL = 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(readFileSync(new URL('../src/main/mobile-device-auth.ts', import.meta.url), 'utf8'), { mode: 'transform' })).toString('base64')
const source = readFileSync(new URL('../src/main/mobile-trust-store.ts', import.meta.url), 'utf8').replaceAll("from './mobile-device-auth'", `from '${registryURL}'`)
const snapshot = () => ({ version: 2, gatewayId: 'gateway', lanAddress: '192.168.1.8', lanPort: 47777, hostEpochs: { host: 2 }, relayRoute: 'A'.repeat(43), relayLocalPort: 47778, records: [{ tokenHash: 'a'.repeat(64), device: { id: 'device', label: 'My Android', pairedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), projectIds: ['project'], capabilities: { input: false, create: false, close: false, quotas: false } }, scopes: [{ projectId: 'project', hostId: 'host', root: '/private-project', hostDigest: 'b'.repeat(64), binding: { actorId: 'alice', generation: 'epoch:2', allowedRoots: ['/private-project'], operateOthers: false } }] }] })
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'crow-mobile-trust-')), key = `__mobileTrust${Math.random().toString().slice(2)}`
  globalThis[key] = { failRename: false }
  const codec = buffer => Buffer.from([...buffer].map(byte => byte ^ 0x55)) // Test double, never production cryptography.
  const secure = { isEncryptionAvailable: () => true, encryptString: text => codec(Buffer.from(text)), decryptString: buffer => codec(buffer).toString() }
  const transformed = stripTypeScriptTypes(source, { mode: 'transform' }).replace('renameSync(temporary, this.path);', `if (globalThis.${key}.failRename) throw new Error('disk'); renameSync(temporary, this.path);`)
  const { MobileTrustStore } = await import('data:text/javascript;base64,' + Buffer.from(transformed).toString('base64'))
  t.after(() => { delete globalThis[key]; rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'mobile-trust.enc')
  return { path, directory, secure, codec, newStore: () => new MobileTrustStore(path, secure), failRename: () => globalThis[key].failRename = true }
}
test('encrypted mobile trust restores identity, endpoint, epochs and grants without plaintext', async t => {
  const f = await fixture(t), value = snapshot(), store = f.newStore()
  assert.equal(store.load(), undefined)
  store.save(value)
  const bytes = readFileSync(f.path)
  for (const secret of ['My Android', 'alice', '/private-project', 'a'.repeat(64), 'A'.repeat(43)]) assert.equal(bytes.includes(Buffer.from(secret)), false)
  assert.deepEqual(f.newStore().load(), value)
  const revoked = { ...value, hostEpochs: { host: 3 }, records: [] }
  store.save(revoked)
  assert.deepEqual(f.newStore().load(), revoked)
  assert.deepEqual(readdirSync(f.directory), ['mobile-trust.enc'])
})
test('unavailable encryption, corrupt or unsupported stores block access without overwriting', async t => {
  const f = await fixture(t), store = f.newStore()
  store.save(snapshot()); const original = readFileSync(f.path)
  f.secure.isEncryptionAvailable = () => false
  assert.throws(() => store.load(), /bloqueado/)
  assert.throws(() => store.save(snapshot()), /bloqueado/)
  assert.deepEqual(readFileSync(f.path), original)
  f.secure.isEncryptionAvailable = () => true
  for (const raw of ['invalid JSON', JSON.stringify({ ...snapshot(), version: 0 }), JSON.stringify({ ...snapshot(), relayRoute: 'not-a-route' }), JSON.stringify({ ...snapshot(), records: [{ ...snapshot().records[0], tokenHash: 'bad' }] }), JSON.stringify({ ...snapshot(), extraSecret: 'unexpected' })]) {
    const corrupt = f.codec(Buffer.from(raw)); writeFileSync(f.path, corrupt)
    assert.throws(() => f.newStore().load(), /bloqueado/)
    assert.deepEqual(readFileSync(f.path), corrupt)
  }
})
test('failed atomic replacement keeps last valid store and cleans temporary files', async t => {
  const f = await fixture(t), store = f.newStore(), value = snapshot()
  store.save(value); const original = readFileSync(f.path)
  f.failRename()
  assert.throws(() => store.save({ ...value, records: [] }), /bloqueado/)
  assert.deepEqual(readFileSync(f.path), original)
  assert.deepEqual(f.newStore().load(), value)
  assert.deepEqual(readdirSync(f.directory), ['mobile-trust.enc'])
})

test('v1 envelope migration preserves exact legacy grants and expiry without implicit key upgrade', async t => {
  const f = await fixture(t), old = { ...snapshot(), version: 1 }
  writeFileSync(f.path, f.codec(Buffer.from(JSON.stringify(old))))
  const migrated = f.newStore().load()
  assert.equal(migrated.version, 2)
  assert.deepEqual(migrated.records, old.records)
  assert.equal(migrated.records[0].publicKey, undefined)
  assert.equal(migrated.records[0].device.expiresAt, old.records[0].device.expiresAt)
  assert.deepEqual(f.newStore().load(), migrated)
})
