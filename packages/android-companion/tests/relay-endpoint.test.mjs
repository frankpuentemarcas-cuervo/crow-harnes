import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const plugin = readFileSync(new URL('../android/app/src/main/java/dev/crow/companion/CrowGatewayPlugin.java', import.meta.url), 'utf8')
const policy = readFileSync(new URL('../android/app/src/main/java/dev/crow/companion/EndpointPolicy.java', import.meta.url), 'utf8')

test('relay endpoint layers pinned inner TLS over a separate default-CA WSS tunnel', () => {
  assert.match(policy, /kind\.equals\("relay"\)/)
  assert.match(policy, /"127\.0\.0\.1"\.equals\(uri\.getHost\(\)\)/)
  assert.match(policy, /relay\.getScheme\(\)/)
  assert.match(policy, /Base64\.URL_SAFE \| Base64\.NO_PADDING \| Base64\.NO_WRAP/)
  assert.match(plugin, /EndpointPolicy\.pinnedTrust\(endpoint\.getString\("certSHA256"\)\)/)
  assert.match(plugin, /builder\.socketFactory\(new CrowRelayTunnelSocket\.Factory\(new OkHttpClient\(\), endpoint\.getString\("relayUrl"\), endpoint\.getString\("relayRoute"\)\)\)/)
  assert.match(plugin, /EndpointPolicy\.origin\(endpoint\)/)
  assert.match(plugin, /endpoint\.getString\("kind"\)\.equals\("relay"\)\) && !call\.getBoolean\("fingerprintConfirmed", false\)/)
  assert.match(plugin, /approvedEndpoint\.put\("relayUrl", endpoint\.getString\("relayUrl"\)\)\.put\("relayRoute", endpoint\.getString\("relayRoute"\)\)/)
})
