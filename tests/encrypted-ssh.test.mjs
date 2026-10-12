import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url), ts = require('typescript')
const source = readFileSync(new URL('../src/main/encrypted-ssh.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const clients = [], servers = [], reads = [], state = { losses: 0 }
  class Client extends EventEmitter {
    constructor() { super(); clients.push(this) }
    connect(config) { this.config = config; queueMicrotask(() => this.emit('ready')); return this }
    end() { this.ended = true; queueMicrotask(() => { this.emit('error', new Error('late teardown')); this.emit('end'); this.emit('close') }); return this }
    destroy() { this.destroyed = true; return this }
    exec(_command, callback) { reads.push(callback) }
  }
  class Server extends EventEmitter {
    listen(_port, _host, callback) { this.listeningCallback = callback; if (!options.holdListen) queueMicrotask(() => { this.listening = true; callback() }); return this }
    address() { return this.listening ? { port: 47000 } : null }
    close() { this.closed = true; this.listening = false }
  }
  const module = { exports: {} }
  const localRequire = id => {
    if (id === 'node:child_process') return { execFile() {} }
    if (id === 'node:util') return { promisify: () => async command => ({ stdout: command === 'ssh' ? 'hostname fictional\nuser fictional\nport 22\n' : 'fictional ssh-rsa dHJ1c3RlZA==\n' }) }
    if (id === 'node:fs') return { readFileSync: () => Buffer.from('FICTITIOUS KEY') }
    if (id === 'ssh2') return { Client, utils: { parseKey: () => ({}) } }
    if (id === 'node:net') return { createServer: () => { const server = new Server(); servers.push(server); return server } }
    return require(id)
  }
  vm.runInNewContext(compiled, { module, exports: module.exports, require: localRequire, Buffer, Error })
  const open = credential => module.exports.EncryptedSshTunnel.open({ target: 'fictional@host', port: 22, identity: 'memory-key', remotePort: 47321 }, 'fictional', () => state.losses++, credential)
  return { state, clients, servers, reads, open: () => open('a'.repeat(32)), openBootstrap: () => open(undefined) }
}

test('real ssh2 resets before handshake do not crash; a fresh tunnel can reconnect and forward', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/ssh-handshake-reset.mjs', import.meta.url))], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.match(result.stdout, /PASS three pre-handshake resets/)
})

test('a connected client error/end/close emits loss once and shuts its local listener', async () => {
  const f = fixture(), tunnel = await f.open()
  try {
    assert.equal(f.clients[0].config.hostVerifier(Buffer.from('trusted')), true)
    assert.equal(f.clients[0].config.hostVerifier(Buffer.from('foreign')), false)
    f.clients[0].emit('error', new Error('network reset')); f.clients[0].emit('end'); f.clients[0].emit('close')
    await tick(); assert.equal(f.state.losses, 1); assert.equal(f.servers[0].closed, true)
    assert.equal(f.clients[0].destroyed, true)
  } finally { tunnel.close(); await tick() }
})

test('explicit close is idempotent and late teardown errors do not notify loss', async () => {
  const f = fixture(), tunnel = await f.open()
  tunnel.close(); tunnel.close(); await tick()
  assert.equal(f.state.losses, 0); assert.equal(f.servers[0].closed, true)
  assert.equal(f.clients[0].destroyed, true)
})

test('close while token retrieval is pending rejects initialization and ignores late data', async () => {
  const f = fixture(); let timeout
  const pending = f.openBootstrap(), outcome = pending.then(value => ({ value }), error => ({ error }))
  try {
    await tick(); assert.equal(f.reads.length, 1)
    f.clients[0].emit('close')
    const result = await Promise.race([outcome, new Promise(resolve => { timeout = setTimeout(() => resolve({ timeout: true }), 100) })])
    assert.ok(result.error, 'Opening must reject instead of hanging on a closed transport')
    assert.equal(f.state.losses, 0)
    const stream = new EventEmitter(); stream.close = () => {}
    f.reads[0](null, stream); stream.emit('data', Buffer.from('a'.repeat(32))); stream.emit('close', 0)
    await tick(); assert.equal(f.servers.length, 0)
  } finally {
    clearTimeout(timeout)
    f.reads[0]?.(new Error('fixture cleanup')); const result = await outcome; result.value?.close(); await tick()
  }
})

test('close during bind rejects opening and a late listening callback cannot resurrect the tunnel', async () => {
  const f = fixture({ holdListen: true }); const pending = f.open(), outcome = pending.then(value => ({ value }), error => ({ error }))
  await tick(); assert.equal(f.servers.length, 1)
  f.clients[0].emit('error', new Error('lost during bind'))
  f.servers[0].listening = true; f.servers[0].listeningCallback()
  const result = await outcome
  try { assert.ok(result.error, 'Lost setup must never publish a tunnel'); assert.equal(f.state.losses, 0); assert.equal(f.servers[0].closed, true) }
  finally { result.value?.close(); await tick() }
})

test('listener errors stay handled after binding and lead to a single loss', async () => {
  const f = fixture(), tunnel = await f.open()
  try {
    assert.doesNotThrow(() => { f.servers[0].emit('error', new Error('listener failed')); f.servers[0].emit('error', new Error('late listener error')) })
    await tick(); assert.equal(f.state.losses, 1); assert.equal(f.servers[0].closed, true)
  } finally { tunnel.close(); await tick() }
})
