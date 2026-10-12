// Isolated real ssh2 regression: no Electron profile, external host or saved key.
import net from 'node:net'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url), ts = require('typescript'), ssh2 = require('ssh2')
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const sockets = new Set()
const reset = net.createServer(socket => {
  sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
  setTimeout(() => socket.resetAndDestroy(), 5)
})
await new Promise(resolve => reset.listen(0, '127.0.0.1', resolve))
let port = reset.address().port
const trusted = ssh2.utils.parseKey(key).getPublicSSH()
const module = { exports: {} }
const localRequire = id => {
  if (id === 'node:child_process') return { execFile() { throw new Error('No external process allowed') } }
  if (id === 'node:util') return { promisify: () => async command => ({ stdout: command === 'ssh' ? `hostname 127.0.0.1\nuser fictional\nport ${port}\n` : `fictional ssh-rsa ${trusted.toString('base64')}\n` }) }
  if (id === 'node:fs') return { readFileSync: () => Buffer.from(key) }
  return require(id)
}
const source = readFileSync(new URL('../../src/main/encrypted-ssh.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
vm.runInNewContext(compiled, { module, exports: module.exports, require: localRequire, Buffer, Error, setTimeout, clearTimeout })
const open = lost => module.exports.EncryptedSshTunnel.open({ target: 'fictional@localhost', port, identity: 'memory-only-key', remotePort: 47321 }, 'fictional', lost, '')
let losses = 0, healthy
try {
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(open(() => losses++), /ECONNRESET|handshake/)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(losses, 0)
  healthy = new ssh2.Server({ hostKeys: [key] }, client => {
    client.on('error', () => {})
    client.on('authentication', context => context.accept())
    client.on('tcpip', (accept, _reject, info) => {
      assert.equal(info.destIP, '127.0.0.1'); assert.equal(info.destPort, 47321)
      const stream = accept(); stream.on('error', () => {}); stream.on('data', bytes => stream.write(bytes))
    })
  })
  await new Promise(resolve => healthy.listen(0, '127.0.0.1', resolve)); port = healthy.address().port
  const tunnel = await open(() => losses++)
  try {
    const socket = net.connect(tunnel.port, '127.0.0.1'); sockets.add(socket)
    const echo = await new Promise((resolve, reject) => {
      socket.once('error', reject); socket.once('data', bytes => resolve(bytes.toString()))
      socket.once('connect', () => socket.write('fictional-reconnect-ping'))
    })
    assert.equal(echo, 'fictional-reconnect-ping'); socket.destroy(); sockets.delete(socket)
  } finally { tunnel.close() }
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(losses, 0)
  console.log('PASS three pre-handshake resets, fresh reconnect and real SSH forwarding without uncaught errors')
} finally {
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => reset.close(resolve))
  if (healthy) await new Promise(resolve => healthy.close(resolve))
}
