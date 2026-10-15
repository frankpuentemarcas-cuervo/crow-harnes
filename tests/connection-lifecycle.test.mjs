import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url), ts = require('typescript')
const source = readFileSync(new URL('../src/main/connection.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(mode = 'healthy') {
  const state = { mode, attempts: [], timers: [], statuses: [], diagnostics: [], fetches: 0, cached: 0 }
  const module = { exports: {} }
  class PassphraseRequiredError extends Error {}
  const localRequire = id => {
    if (id === './encrypted-ssh') return { isEncryptedKey: () => true, PassphraseRequiredError, EncryptedSshTunnel: { open: async (_host, _phrase, lost) => {
      const handle = { token: 'a'.repeat(32), port: 47000, closed: false, lost, readBootstrapToken: async () => 'a'.repeat(32), close() { this.closed = true } }
      state.attempts.push(handle)
      if (state.mode === 'fail') throw new Error('ECONNRESET')
      if (state.mode === 'lost-before-return') { handle.close(); lost() }
      return handle
    } } }
    if (id === './transport-failure') return { isTransportFailure: () => false }
    if (id === './installation-identity') return { getInstallationId: () => 'c'.repeat(32) }
    if (id === './connection-diagnostics') return { safeFailureReason: value => /ECONNRESET/.test(value?.message || '') ? 'network-reset' : 'unknown', safeConnectionCode: () => undefined }
    if (id === 'node:child_process') return { spawn() { throw new Error('External SSH forbidden') }, execFile() {} }
    if (id.startsWith('node:')) return require(id)
    return {}
  }
  const globals = { module, exports: module.exports, require: localRequire, Error, Buffer, AbortSignal,
    setTimeout: (callback, delay) => { const timer = { callback, delay, cancelled: false, fired: false }; state.timers.push(timer); return timer },
    clearTimeout: timer => { timer.cancelled = true }, setInterval: () => ({}), clearInterval: () => {},
    fetch: async url => {
      state.fetches++
      if (state.mode === 'hold-access' && state.fetches === 2) await new Promise(resolve => { state.release = resolve })
      return new Response(JSON.stringify(url.includes('/api/events') ? [] : url.includes('/api/access/me') ? { role: 'installation', id: `installation:${'c'.repeat(32)}`, allowedRoots: [] } : { enabled: false }))
    }
  }
  vm.runInNewContext(compiled, globals)
  const connection = new module.exports.Connection({ id: 'fictional', target: 'fictional@host', identity: 'memory-key', port: 22, remotePort: 47321 }, { eventCursor: () => 0 }, { get: () => 'fictional', set: () => { state.cached++ } }, (_host, status) => state.statuses.push(status), () => {}, () => {}, () => false, { get: () => 'a'.repeat(32) }, entry => state.diagnostics.push(entry))
  const retries = () => state.timers.filter(timer => !timer.cancelled && !timer.fired)
  return { state, connection, retries, retry: () => { const timer = retries()[0]; timer.fired = true; timer.callback() } }
}

test('failed opening retries automatically; duplicate loss notifications schedule only one reconnect', async () => {
  const f = fixture('fail')
  try {
    await assert.rejects(f.connection.connect(), /ECONNRESET/); assert.equal(f.retries().length, 1)
    assert.ok(f.state.diagnostics.some(row => row.event === 'connect-failed' && row.reason === 'network-reset'))
    assert.ok(f.state.diagnostics.some(row => row.event === 'reconnect-scheduled' && row.retryMs >= 1000))
    f.state.mode = 'healthy'; f.retry(); await tick(); assert.equal(f.connection.status(), 'connected')
    assert.equal(f.state.attempts.length, 2)
    f.state.attempts[1].lost(); f.state.attempts[1].lost(); assert.equal(f.retries().length, 1)
    assert.equal(f.state.diagnostics.filter(row => row.event === 'transport-lost').length, 1)
    assert.equal(f.state.attempts[1].closed, true)
    f.retry(); await tick(); assert.equal(f.connection.status(), 'connected'); assert.equal(f.state.attempts.length, 3)
  } finally { f.connection.stop() }
})

test('stopping cancels retry and a delayed access result cannot mark a closed tunnel connected', async () => {
  const f = fixture('fail')
  await assert.rejects(f.connection.connect()); f.connection.stop(); assert.equal(f.retries().length, 0)
  f.state.mode = 'hold-access'; f.state.fetches = 0
  const result = f.connection.connect().then(() => ({ ok: true }), error => ({ error }))
  await tick(); assert.equal(typeof f.state.release, 'function'); f.connection.stop(); f.state.release()
  try {
    assert.ok((await result).error, 'Cancelled opening must reject after the delayed response')
    assert.equal(f.connection.status(), 'disconnected'); assert.equal(f.state.cached, 0)
    assert.equal(f.retries().length, 0)
  } finally { f.connection.stop() }
})

test('loss just before ownership handoff never publishes the closed tunnel', async () => {
  const f = fixture('lost-before-return')
  try {
    await assert.rejects(f.connection.connect(), /SSH|conexión/i)
    assert.equal(f.connection.status(), 'disconnected'); assert.equal(f.state.cached, 0)
    assert.equal(f.retries().length, 1); assert.equal(f.state.attempts[0].closed, true)
  } finally { f.connection.stop() }
})

test('a lost owned tunnel cannot resurrect through a late access check', async () => {
  const f = fixture('hold-access'), result = f.connection.connect().then(() => ({ ok: true }), error => ({ error }))
  await tick(); f.state.attempts[0].lost(); f.state.release()
  try {
    assert.ok((await result).error); assert.equal(f.connection.status(), 'disconnected')
    assert.equal(f.state.cached, 0); assert.equal(f.retries().length, 1)
  } finally { f.connection.stop() }
})

test('stopping and starting again permits a fresh retry instead of retaining a cancelled timer', async () => {
  const f = fixture('fail')
  try {
    await assert.rejects(f.connection.connect()); f.connection.stop()
    await assert.rejects(f.connection.connect()); assert.equal(f.retries().length, 1)
    f.state.mode = 'healthy'; f.retry(); await tick(); assert.equal(f.connection.status(), 'connected')
  } finally { f.connection.stop() }
})
