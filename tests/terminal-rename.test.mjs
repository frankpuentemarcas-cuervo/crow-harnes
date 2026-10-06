import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../src/main/store.ts'
import { normalizeSessionName } from '../src/shared/session-list.ts'

function removeTestDirectory(dir) {
  assert.equal(resolve(dirname(dir)), resolve(tmpdir()))
  assert.ok(basename(dir).startsWith('crow-rename-'))
  rmSync(dir, { recursive: true, force: true })
}

test('renaming never uses the prompt API unsupported by Electron', () => {
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  assert.ok(!app.includes('window.prompt('))
  assert.ok(app.includes('<RenameTerminalDialog'))
})

test('terminal names trim whitespace, allow reset and count Unicode code points', () => {
  assert.equal(normalizeSessionName('  Mi QA  '), 'Mi QA')
  assert.equal(normalizeSessionName('   '), '')
  assert.equal(normalizeSessionName('😀'.repeat(48)), '😀'.repeat(48))
  assert.throws(() => normalizeSessionName('😀'.repeat(49)), /48 caracteres/)
})

test('renaming persists per host and session; an empty name restores the agent label', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-rename-'))
  try {
    let store = new Store(dir)
    const a = store.saveHost({ name: 'Host A', target: 'user@host-a', port: 22, remotePort: 47321 }).hosts[0].id
    const b = store.saveHost({ name: 'Host B', target: 'user@host-b', port: 22, remotePort: 47321 }).hosts[1].id
    const session = '0123456789abcdef0123456789abcdef'
    store.renameSession(a, session, '  Desarrollador  ')
    store.renameSession(b, session, 'QA')
    store = new Store(dir)
    assert.equal(store.sessionName(a, session), 'Desarrollador')
    assert.equal(store.sessionName(b, session), 'QA')
    store.renameSession(a, session, '')
    assert.equal(new Store(dir).sessionName(a, session), undefined)
    assert.equal(new Store(dir).sessionName(b, session), 'QA')
  } finally { removeTestDirectory(dir) }
})

test('invalid rename leaves the previously saved label unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-rename-'))
  try {
    const store = new Store(dir)
    const host = store.saveHost({ name: 'Host', target: 'user@host', port: 22, remotePort: 47321 }).hosts[0].id
    const session = '0123456789abcdef0123456789abcdef'
    store.renameSession(host, session, 'QA')
    assert.throws(() => store.renameSession(host, session, 'a'.repeat(49)), /48 caracteres/)
    assert.throws(() => store.renameSession('missing', session, 'Nuevo'), /inválida/)
    assert.equal(new Store(dir).sessionName(host, session), 'QA')
  } finally { removeTestDirectory(dir) }
})
