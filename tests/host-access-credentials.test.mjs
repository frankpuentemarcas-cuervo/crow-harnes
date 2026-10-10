import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { stripTypeScriptTypes } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync(new URL('../src/main/host-credential-vault.ts', import.meta.url), 'utf8')
const token = 'a'.repeat(32)
async function fixture(t, secure = true) {
  const directory = mkdtempSync(join(tmpdir(), 'crow-host-credentials-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const key = `__crowCredentialFixture${Math.random().toString().slice(2)}`
  globalThis[key] = { app: { getPath: () => directory }, safeStorage: {
    isEncryptionAvailable: () => secure,
    encryptString: text => Buffer.from([...Buffer.from(text)].map(byte => byte ^ 0x55)),
    decryptString: buffer => Buffer.from([...buffer].map(byte => byte ^ 0x55)).toString()
  } }
  t.after(() => delete globalThis[key])
  const mock = source.replace("import { app, safeStorage } from 'electron'", `const { app, safeStorage } = globalThis.${key}`)
  const { HostCredentialVault } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(mock)).toString('base64'))
  return { HostCredentialVault, path: join(directory, 'credentials.json') }
}

test('host credentials persist encrypted, bind to host target and never enter plaintext state', async t => {
  const { HostCredentialVault, path } = await fixture(t)
  const vault = new HostCredentialVault(path)
  vault.set('host1', 'shared@server:22:47321', token)
  assert.equal(vault.get('host1', 'shared@server:22:47321'), token)
  assert.equal(vault.get('host1', 'other@server:22:47321'), undefined)
  assert.equal(vault.get('host2', 'shared@server:22:47321'), undefined)
  assert.equal(readFileSync(path, 'utf8').includes(token), false)
  assert.equal(new HostCredentialVault(path).get('host1', 'shared@server:22:47321'), token)
})
test('host credentials fail closed on unavailable encryption, bad credential and corrupt store', async t => {
  const { HostCredentialVault, path } = await fixture(t, false)
  const vault = new HostCredentialVault(path)
  assert.throws(() => vault.set('host', 'target', token))
  assert.throws(() => vault.set('host', 'target', 'bad'))
  writeFileSync(path, '{invalid')
  assert.throws(() => new HostCredentialVault(path))
  assert.equal(readFileSync(path, 'utf8'), '{invalid')
})
test('tunnels check access before reading bootstrap and bypass bootstrap retrieval with supplied credential', () => {
  const connection = readFileSync(new URL('../src/main/connection.ts', import.meta.url), 'utf8')
  const encrypted = readFileSync(new URL('../src/main/encrypted-ssh.ts', import.meta.url), 'utf8')
  assert.ok(connection.indexOf('const accessResponse = await fetch') < connection.indexOf("'cat ~/.local/share/crow-harness/token'"))
  assert.match(connection, /if \(!individualCredential\) throw new AccessCredentialRequiredError/)
  assert.match(connection, /if \(!\(error instanceof AccessCredentialRequiredError\)\) this\.scheduleRetry/)
  assert.match(encrypted, /tunnel\.token = individualCredential \?\? await tunnel\.readToken\(\)/)
})
