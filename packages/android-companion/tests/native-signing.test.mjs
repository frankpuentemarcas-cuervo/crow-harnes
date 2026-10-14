import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto'
import vm from 'node:vm'
const source = name => readFileSync(new URL(`../android/app/src/main/java/dev/crow/companion/${name}.java`, import.meta.url), 'utf8')

test('v2 device identity uses P256 AndroidKeyStore without exporting private key material', () => {
  const key = source('DeviceSigningKey')
  assert.match(key, /KeyPairGenerator\.getInstance\(KeyProperties\.KEY_ALGORITHM_EC, "AndroidKeyStore"\)/)
  assert.match(key, /ECGenParameterSpec\("secp256r1"\)/)
  assert.match(key, /KeyProperties\.PURPOSE_SIGN/)
  assert.match(key, /KeyProperties\.DIGEST_SHA256/)
  assert.match(key, /getCertificate\(alias\)\.getPublicKey\(\)\.getEncoded\(\)/)
  assert.match(key, /Signature\.getInstance\("SHA256withECDSA"\)/)
  assert.doesNotMatch(key, /privateKey\.getEncoded|PKCS8EncodedKeySpec|setKeyEntry|Log\.|System\.out/)
})

test('challenge signature is bound to gateway, device, fresh nonce and fixed v2 domain', () => {
  const key = source('DeviceSigningKey')
  assert.match(key, /challenge\.getInt\("version"\) != 2/)
  assert.match(key, /gatewayId\.equals\(challenge\.getString\("gatewayId"\)\)/)
  assert.match(key, /deviceId\.equals\(challenge\.getString\("deviceId"\)\)/)
  assert.match(key, /\[0-9a-f\]\{64\}/)
  assert.match(key, /expires\.isAfter\(now\)/)
  assert.match(key, /now\.plusSeconds\(31\)/)
  const literal = key.match(/String payload = "((?:[^"\\]|\\.)*)"/)[1]
  assert.equal(JSON.parse(`"${literal}"`), 'crow-mobile-renew:v2\n')
  assert.match(key, /\+ gatewayId \+ "\\n" \+ deviceId \+ "\\n" \+ challengeId \+ "\\n" \+ nonce;/)
  const fields = { gatewayId: 'gateway', deviceId: 'device', challengeId: '00000000-0000-4000-8000-000000000000', nonce: 'a'.repeat(64) }
  // This concatenation is valid in both Java and JS: exercise the actual native source expression.
  const payload = vm.runInNewContext(key.match(/String payload = (.+);/)[1], fields)
  assert.equal(createHash('sha256').update(payload, 'utf8').digest('hex'), 'bf838d14124ba64344e40bc41eb5f9923c6f7ea5234e1c7c19db73baa623eace')
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  assert.equal(spki.length, 91)
  const peer = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  const signature = sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'der' })
  assert.equal(verify('sha256', Buffer.from(payload), peer, signature), true)
  assert.equal(verify('sha256', Buffer.from(payload + '\n'), peer, signature), false)
  assert.equal(verify('sha256', Buffer.from(payload.replace('gateway', 'foreign')), peer, signature), false)
  assert.match(key, /signature\.update\(payload\.getBytes\(StandardCharsets\.UTF_8\)\)/)
})

test('v2 pair stores a private alias but never bearer, and no secrets reach the JS profile', () => {
  const native = source('CrowGatewayPlugin')
  assert.match(native, /"\/api\/v2\/pair"/)
  assert.match(native, /body\.put\("publicKey", DeviceSigningKey\.publicKey\(alias\)\)/)
  assert.match(native, /saved\.put\("signingAlias", alias\)/)
  assert.doesNotMatch(native, /saved\.put\("credential"/)
  assert.doesNotMatch(native, /profile\.put\("(?:signingAlias|credential|privateKey)"/)
  assert.match(native, /private final ConcurrentHashMap<String, AccessCredential> accessCredentials/)
})

test('legacy stored profiles keep their own expiry but new enrollment never calls v1 pair', () => {
  const native = source('CrowGatewayPlugin')
  assert.doesNotMatch(native, /"\/api\/v1\/pair"/)
  assert.match(native, /Actualizá Crow en Windows y generá un nuevo QR/)
  assert.match(native, /if \(record\.optInt\("authVersion", 1\) != 2\) return record\.getString\("credential"\)/)
  assert.match(native, /else if \(!Instant\.parse\(record\.getJSONObject\("profile"\)/)
})

test('renewal happens before transport use and never replays a terminal action', () => {
  const native = source('CrowGatewayPlugin')
  assert.match(native, /"\/api\/v2\/device-challenge"/)
  assert.match(native, /"\/api\/v2\/device-renew"/)
  assert.match(native, /DeviceSigningKey\.signChallenge\(/)
  assert.match(native, /accessCredential\(id, record, g, e\)/)
  assert.match(native, /accessCredential\(stream\.profileId, record, stream\.generation, stream\.epoch\)/)
  assert.match(native, /credentialExpiresAt/)
  assert.match(native, /retryOnConnectionFailure\(false\)/)
  assert.doesNotMatch(native, /catch[^\n]*401[^\n]*http\(/)
})

test('transient failures retain profiles and keys; explicit forget removes both and volatile access', () => {
  const native = source('CrowGatewayPlugin')
  const http = native.slice(native.indexOf('private Object http('), native.indexOf('private void forget('))
  assert.doesNotMatch(http, /forget\(profileId\)/)
  const listing = native.slice(native.indexOf('@PluginMethod public void listProfiles'), native.indexOf('@PluginMethod public void deleteProfile'))
  assert.doesNotMatch(listing, /forget\(id\)/)
  assert.match(native, /DeviceSigningKey\.delete\(alias\)/)
  assert.match(native, /accessCredentials\.remove\(id\)/)
  assert.match(native, /handleOnPause\(\)[^\n]*accessCredentials\.clear\(\)/)
})

test('every explicit v2 mutation gets a fresh native body requestId without modifying JS payloads', () => {
  const native = source('CrowGatewayPlugin'), policy = source('EndpointPolicy')
  const helper = native.slice(native.indexOf('private JSONObject mutationBody('), native.indexOf('private String accessCredential('))
  assert.match(helper, /new JSONObject\(body\.toString\(\)\)/)
  assert.match(helper, /if \(record\.optInt\("authVersion", 1\) == 2\) copy\.put\("requestId", UUID\.randomUUID\(\)\.toString\(\)\)/)
  const request = native.slice(native.indexOf('@PluginMethod public void request'), native.indexOf('@PluginMethod public void openStream'))
  assert.match(request, /method\.equals\("POST"\) \? mutationBody\(record, call\.getObject\("body"\)\) : null/)
  for (const action of ['sessions', 'wake', 'close']) assert.ok(policy.includes(`path.equals("/api/v1/${action}")`))
  const send = native.slice(native.indexOf('@PluginMethod public void send'), native.indexOf('@PluginMethod public void closeStream'))
  for (const action of ['input', 'resize']) assert.ok(send.includes(`type.equals("${action}")`))
  assert.match(send, /mutationBody\(record, body\)/)
  assert.equal((native.match(/mutationBody\(/g) || []).length, 3, 'only request and send invoke mutation helper')
  const auth = native.slice(native.indexOf('private String accessCredential('), native.indexOf('private OkHttpClient client(')) + native.slice(native.indexOf('private void completePair('), native.indexOf('@PluginMethod public void listProfiles'))
  assert.doesNotMatch(auth, /requestId|mutationBody/)
  assert.doesNotMatch(helper, /store\.save|accessCredentials\.put|http\(/)
  assert.match(native, /retryOnConnectionFailure\(false\)/)
  assert.doesNotMatch(request + send, /for\s*\(|while\s*\(|catch[^\n]*http\(/)
})
