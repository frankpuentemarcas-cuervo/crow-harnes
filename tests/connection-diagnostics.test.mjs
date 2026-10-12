import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url), ts = require('typescript')
const source = readFileSync(new URL('../src/main/connection-diagnostics.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function load() {
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, require, Buffer, Date })
  return module.exports
}

test('connection diagnostics export only allowlisted fields and never persists raw SSH text', () => {
  const { ConnectionDiagnosticsStore, safeFailureReason } = load(), dir = mkdtempSync(join(tmpdir(), 'crow-diagnostics-'))
  try {
    const store = new ConnectionDiagnosticsStore(dir)
    store.record({ hostId: 'host-123', transport: 'openssh', event: 'tunnel-error', reason: safeFailureReason({ message: 'Permission denied for frank@private-server with secret-token' }), code: 'EACCES', state: 'connected', retryMs: -20, message: 'secret-token' })
    const exported = store.exportJSON('host-123')
    assert.match(exported, /authentication-failed/)
    assert.doesNotMatch(exported, /private-server|frank|secret-token|EACCES/)
    assert.equal(JSON.parse(exported).records[0].state, 'connected')
    assert.equal(JSON.parse(exported).records[0].retryMs, undefined)
    assert.doesNotMatch(readFileSync(join(dir, 'connection-diagnostics.jsonl'), 'utf8'), /secret-token/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('connection diagnostic log rotates once and exports only the requested host', () => {
  const { ConnectionDiagnosticsStore } = load(), dir = mkdtempSync(join(tmpdir(), 'crow-diagnostics-'))
  try {
    const store = new ConnectionDiagnosticsStore(dir)
    for (let index = 0; index < 12000; index++) store.record({ hostId: index % 2 ? 'host-a' : 'host-b', transport: 'ssh2', event: 'reconnect-scheduled', retryMs: 15000 })
    const exportData = JSON.parse(store.exportJSON('host-a'))
    assert.ok(exportData.records.length > 0)
    assert.ok(exportData.records.every(row => row.hostId === 'host-a'))
    assert.ok(readFileSync(join(dir, 'connection-diagnostics.jsonl.1'), 'utf8').length <= 1024 * 1024)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
