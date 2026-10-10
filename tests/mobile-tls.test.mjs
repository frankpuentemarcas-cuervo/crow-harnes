import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'

test('LAN certificate pin is SHA256 of the leaf DER, with SAN address and encrypted persistence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-mobile-tls-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const key = `__mobileTLS${Date.now()}`
  const require = createRequire(import.meta.url)
  globalThis[key] = { forge, app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from([...Buffer.from(text)].map(byte => byte ^ 0x55)), decryptString: value => Buffer.from([...value].map(byte => byte ^ 0x55)).toString() }, ws: require('ws') }
  t.after(() => delete globalThis[key])
  let source = readFileSync(new URL('../src/main/mobile-gateway.ts', import.meta.url), 'utf8')
  source = stripTypeScriptTypes(source, { mode: 'transform' })
    .replace("import { app, safeStorage } from 'electron';", `const { app, safeStorage } = globalThis.${key};`)
    .replace("import forge from 'node-forge';", `const { forge } = globalThis.${key};`)
    .replace("import { WebSocket, WebSocketServer } from 'ws';", `const { WebSocket, WebSocketServer } = globalThis.${key}.ws;`)
    .replace("import { isPrivateLanIPv4 } from './mobile-network';", 'const isPrivateLanIPv4 = () => true;')
    .replace(/import \{ MobileDeviceRegistry, READ_CAPABILITIES \} from '.\/mobile-device-auth';/, 'const MobileDeviceRegistry = class {}; const READ_CAPABILITIES = {};')
  const { certificate } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { certificate };').toString('base64'))
  const tls = certificate('192.168.1.8')
  const cert = forge.pki.certificateFromPem(tls.cert)
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const expected = createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex').match(/.{2}/g).join(':').toUpperCase()
  assert.equal(tls.fingerprint, expected)
  const san = cert.getExtension('subjectAltName')
  assert.ok(san.altNames.some(name => name.ip === '192.168.1.8'))
  assert.ok(san.altNames.some(name => name.ip === '127.0.0.1'))
  assert.equal(readFileSync(join(dir, 'mobile-tls.enc')).includes(Buffer.from('PRIVATE KEY')), false)
  assert.equal(certificate('192.168.1.8').fingerprint, expected)
  globalThis[key].safeStorage.isEncryptionAvailable = () => false
  assert.throws(() => certificate('192.168.1.8'), /cifrado local/)
})
