import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { stripTypeScriptTypes } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync(new URL('../src/main/installation-identity.ts', import.meta.url), 'utf8')

async function loadIdentity(t, userDataPath) {
  const key = `__crowIdentityFixture${Math.random().toString().slice(2)}`
  globalThis[key] = { app: { getPath: () => userDataPath } }
  t.after(() => delete globalThis[key])
  const mocked = source.replace("import { app } from 'electron'", `const { app } = globalThis.${key}`)
  return import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(mocked)).toString('base64'))
}

test('installation identity is stable per local Crow profile and different across profiles', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'crow-installation-id-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const profileA = join(directory, 'profile-a')
  const profileB = join(directory, 'profile-b')
  const a = await loadIdentity(t, profileA)
  const b = await loadIdentity(t, profileB)
  const idA = a.getInstallationId()
  assert.match(idA, /^[0-9a-f]{32}$/)
  assert.equal(a.getInstallationId(), idA)
  assert.notEqual(b.getInstallationId(), idA)
})

test('installation identity fails closed when its persisted value is corrupt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'crow-installation-id-corrupt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'installation-id')
  writeFileSync(path, 'not-a-valid-id')
  const identity = await loadIdentity(t, directory)
  assert.throws(() => identity.getInstallationId(path), /está dañada/)
  assert.equal(readFileSync(path, 'utf8'), 'not-a-valid-id')
})
