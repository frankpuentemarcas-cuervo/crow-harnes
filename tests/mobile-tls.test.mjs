import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
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
    .replace("import { MOBILE_SUPPORTED_FEATURES } from '../shared/mobile-companion';", 'const MOBILE_SUPPORTED_FEATURES = {};')
    .replace(/import \{[^}]+\} from '.\/mobile-device-auth';/, 'const MobileDeviceRegistry = class {}; const READ_CAPABILITIES = {}; const MobileHostUnavailableError = class extends Error {}; const MobileAuthorizationChangedError = class extends Error {};')
    .replace("import { MobileTrustStore } from './mobile-trust-store';", 'const MobileTrustStore = class {};')
    .replace(/import \{[^}]+\} from '.\/mobile-mutation-ledger';/, 'const MobileMutationLedger = class {}; const MobileMutationRejectedError = class extends Error {};')
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

test('gateway restart preserves endpoint, identity, epochs and trust; revocation survives a second restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-mobile-resume-')), key = `__mobileResume${Date.now()}`
  const require = createRequire(import.meta.url)
  globalThis[key] = { forge, app: { isPackaged: true, getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: value => value.toString() }, ws: require('ws') }
  const ts = path => stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'), { mode: 'transform' })
  const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  const registryURL = dataURL(ts('../src/main/mobile-device-auth.ts'))
  const mobileAuth = await import(registryURL)
  const trustStoreURL = dataURL(ts('../src/main/mobile-trust-store.ts').replace("from './mobile-device-auth'", `from '${registryURL}'`))
  const ledgerURL = dataURL(ts('../src/main/mobile-mutation-ledger.ts'))
  const source = ts('../src/main/mobile-gateway.ts')
    .replace("import { app, safeStorage } from 'electron';", `const { app, safeStorage } = globalThis.${key};`)
    .replace("import forge from 'node-forge';", `const { forge } = globalThis.${key};`)
    .replace("import { WebSocket, WebSocketServer } from 'ws';", `const { WebSocket, WebSocketServer } = globalThis.${key}.ws;`)
    .replace("import { isPrivateLanIPv4 } from './mobile-network';", 'const isPrivateLanIPv4 = () => true;')
    .replace("import { MOBILE_SUPPORTED_FEATURES } from '../shared/mobile-companion';", 'const MOBILE_SUPPORTED_FEATURES = {};')
    .replace("import { networkInterfaces } from 'node:os';", "const networkInterfaces = () => ({ test: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }] });")
    .replace("from './mobile-device-auth'", `from '${registryURL}'`)
    .replace("from './mobile-trust-store'", `from '${trustStoreURL}'`)
    .replace("from './mobile-mutation-ledger'", `from '${ledgerURL}'`)
  const { MobileGateway } = await import(dataURL(source))
  const state = { hosts: [{ id: 'host', target: 'user@mock', port: 22, remotePort: 47000 }], projects: [{ id: 'project', hostId: 'host', root: '/work' }] }
  const gateways = []
  const make = () => { const gateway = new MobileGateway({ snapshot: () => state, connection: () => ({ status: () => 'connected' }), authSnapshot: async () => ({ actorId: 'alice', generation: `epoch:${gateway.hostAuthorizationEpoch('host')}`, allowedRoots: ['/work'], operateOthers: false, role: 'member' }) }); gateways.push(gateway); return gateway }
  const gateway = make()
  gateway.invalidateHost('host') // Simulate a credential import before the first enrollment.
  t.after(async () => { for (const instance of gateways) { await instance.stop(); instance.sockets.close() } delete globalThis[key]; rmSync(dir, { recursive: true, force: true }) })
  const first = await gateway.start('127.0.0.1'), invite = await gateway.invite({ projectIds: ['project'] }, 1)
  const paired = gateway.registry.pair(invite.invitationCode, 'Android')
  const paused = await gateway.stop()
  assert.equal(paused.devices[0].id, paired.record.device.id)
  const restarted = make(), resumed = await restarted.start('127.0.0.1')
  assert.equal(resumed.url, first.url); assert.equal(resumed.fingerprint, first.fingerprint)
  assert.equal((await restarted.invite({ projectIds: ['project'] }, 1)).gatewayId, invite.gatewayId)
  assert.equal(restarted.hostAuthorizationEpoch('host'), 1)
  const restored = restarted.registry.authenticate(paired.credential)
  assert.equal(restored.device.id, paired.record.device.id)
  await restarted.validateDevice(restored)
  restarted.revoke(paired.record.device.id)
  await restarted.stop()
  const third = make()
  assert.equal(third.status().devices.length, 0)
  assert.equal(third.registry.authenticate(paired.credential), undefined)
  assert.equal(third.hostAuthorizationEpoch('host'), 1)
  await third.start('127.0.0.1')
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), invitation = await third.invite({ projectIds: ['project'] })
  const keyPaired = third.registry.pairKey(invitation.invitationCode, 'Key Android', keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))
  assert.equal(readFileSync(join(dir, 'mobile-trust.enc')).includes(Buffer.from(keyPaired.credential)), false)
  await third.stop()
  const fourth = make(); await fourth.start('127.0.0.1')
  assert.equal(fourth.registry.authenticate(keyPaired.credential), undefined, 'short bearer is never restored after restart')
  const challenge = fourth.registry.challenge(keyPaired.record.device.id, invitation.gatewayId, 'ip')
  const signature = sign('sha256', mobileAuth.deviceProofPayload(challenge), keys.privateKey).toString('base64')
  const restoredKeyDevice = fourth.registry.prove(keyPaired.record.device.id, challenge.challengeId, signature)
  await fourth.validateDevice(restoredKeyDevice)
  const renewed = fourth.registry.issueCredential(restoredKeyDevice)
  assert.equal(fourth.registry.authenticate(renewed.credential).device.id, keyPaired.record.device.id)
})

test('relay endpoint keeps an encrypted route and stable loopback TLS port across gateway restarts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-mobile-relay-resume-')), key = `__mobileRelayResume${Date.now()}`
  const require = createRequire(import.meta.url)
  globalThis[key] = { forge, app: { isPackaged: true, getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: value => value.toString() }, ws: require('ws') }
  const ts = path => stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'), { mode: 'transform' })
  const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  const registryURL = dataURL(ts('../src/main/mobile-device-auth.ts'))
  const trustStoreURL = dataURL(ts('../src/main/mobile-trust-store.ts').replace("from './mobile-device-auth'", `from '${registryURL}'`))
  const ledgerURL = dataURL(ts('../src/main/mobile-mutation-ledger.ts'))
  const source = ts('../src/main/mobile-gateway.ts')
    .replace("import { app, safeStorage } from 'electron';", `const { app, safeStorage } = globalThis.${key};`)
    .replace("import forge from 'node-forge';", `const { forge } = globalThis.${key};`)
    .replace("import { WebSocket, WebSocketServer } from 'ws';", `const { WebSocket, WebSocketServer } = globalThis.${key}.ws;`)
    .replace("import { isPrivateLanIPv4 } from './mobile-network';", 'const isPrivateLanIPv4 = () => true;')
    .replace("import { MOBILE_SUPPORTED_FEATURES } from '../shared/mobile-companion';", 'const MOBILE_SUPPORTED_FEATURES = {};')
    .replace("import { networkInterfaces } from 'node:os';", "const networkInterfaces = () => ({ test: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }] });")
    .replace("from './mobile-device-auth'", `from '${registryURL}'`)
    .replace("from './mobile-trust-store'", `from '${trustStoreURL}'`)
    .replace("from './mobile-mutation-ledger'", `from '${ledgerURL}'`)
  const { MobileGateway } = await import(dataURL(source))
  const state = { hosts: [{ id: 'host', target: 'user@mock', port: 22, remotePort: 47000 }], projects: [{ id: 'project', hostId: 'host', root: '/work' }] }
  const relays = [], gateways = []
  const make = () => {
    const gateway = new MobileGateway({ snapshot: () => state, connection: () => ({ status: () => 'connected' }), authSnapshot: async () => ({ actorId: 'alice', generation: `epoch:${gateway.hostAuthorizationEpoch('host')}`, allowedRoots: ['/work'], operateOthers: false, role: 'member' }), relayClientFactory: options => { const relay = { options, start() {}, stop() {}, status: () => ({ state: 'connected', activeStreams: 0, reconnectAttempts: 0 }) }; relays.push(relay); return relay } })
    gateways.push(gateway); return gateway
  }
  const url = 'wss://relay.example.com/v1/tunnel'
  const first = make(), firstStatus = await first.start({ address: '127.0.0.1', relayUrl: url })
  const firstInvite = await first.invite({ projectIds: ['project'] })
  const firstRelay = firstInvite.endpoints.find(endpoint => endpoint.kind === 'relay')
  assert.equal(firstRelay.relayUrl, url)
  assert.match(firstRelay.relayRoute, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(firstRelay.certSHA256, firstStatus.fingerprint)
  await first.stop()

  const resumed = make(), resumedStatus = await resumed.start({ address: '127.0.0.1' })
  const resumedInvite = await resumed.invite({ projectIds: ['project'] })
  const resumedRelay = resumedInvite.endpoints.find(endpoint => endpoint.kind === 'relay')
  assert.equal(resumedStatus.relayState, 'connected')
  assert.equal(resumedRelay.relayUrl, url)
  assert.equal(resumedRelay.relayRoute, firstRelay.relayRoute)
  assert.equal(new URL(resumedRelay.url).port, new URL(firstRelay.url).port)
  assert.equal(relays[1].options.localPort, relays[0].options.localPort)
  t.after(async () => { for (const instance of gateways) { await instance.stop(); instance.sockets.close() } delete globalThis[key]; rmSync(dir, { recursive: true, force: true }) })
})
