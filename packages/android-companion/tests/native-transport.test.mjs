import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const native = readFileSync(new URL('../android/app/src/main/java/dev/crow/companion/CrowGatewayPlugin.java', import.meta.url), 'utf8')
const relaySocket = readFileSync(new URL('../android/app/src/main/java/dev/crow/companion/CrowRelayTunnelSocket.java', import.meta.url), 'utf8')

test('read-only history and stream setup cannot queue ahead of explicit terminal input', () => {
  assert.match(native, /readWorker = Executors\.newFixedThreadPool\(2\)/)
  assert.match(native, /"GET"\.equals\(call\.getString\("method", "GET"\)\) \? readWorker : worker/)
  const send = native.slice(native.indexOf('@PluginMethod public void send'), native.indexOf('@PluginMethod public void closeStream'))
  assert.match(send, /execute\(call, \(\) ->/)
  assert.match(native, /synchronized \(renewalLocks\.computeIfAbsent\(id/)
  assert.match(native, /current\.value\.equals\(usedCredential\)\) accessCredentials\.remove\(id, current\)/)
})

test('reuses profile-bound transports and releases them only on unlink or lifecycle shutdown', () => {
  assert.match(native, /transports\.get\(profileId, binding/)
  assert.match(native, /String binding = [^\n]*certSHA256[^\n]*relayUrl[^\n]*relayRoute/)
  assert.match(native, /finally \{ if \(profileId == null\) GatewayTransportPool\.release\(base\)/)
  assert.match(native, /transports\.remove\(id\)/)
  assert.match(native, /handleOnPause\(\)[^\n]*transports\.clear\(\)/)
  assert.doesNotMatch(native, /onClosed[^\n]*evictAll|onFailure[^\n]*executorService\(\)\.shutdown/)
  assert.match(native, /retryOnConnectionFailure\(false\)/)
})

test('authorized state can restore input after a session becomes writable without granting missing input capability', () => {
  assert.match(native, /stream\.writable = stream\.inputGranted && frame\.getJSONObject\("info"\)\.optBoolean\("canOperate"\) && !frame\.getJSONObject\("info"\)\.optBoolean\("readOnly"\)/)
})

test('Android relay tunnel sends keepalives while an existing terminal is idle', () => {
  assert.match(relaySocket, /pingInterval\(20, TimeUnit\.SECONDS\)/)
  assert.match(native, /pingInterval\(20, TimeUnit\.SECONDS\)/)
})
