import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../android/app/src/main/java/dev/crow/companion/CrowRelayTunnelSocket.java', import.meta.url), 'utf8')

test('native relay Socket transports raw ordered TLS bytes with bounded queues', () => {
  assert.match(source, /extends Socket/)
  assert.match(source, /MAX_QUEUED_BYTES = 1024 \* 1024/)
  assert.match(source, /MAX_FRAME_BYTES = \(64 \* 1024\) - 40/)
  assert.match(source, /copy\.length > MAX_QUEUED_BYTES - inboundBytes/)
  assert.match(source, /socket\.queueSize\(\) > MAX_QUEUED_BYTES - count/)
  assert.match(source, /ByteBuffer\.wrap\(copy\)/)
  assert.match(source, /head\.get\(bytes, offset, count\)/)
  assert.match(source, /socket\.send\(ByteString\.of\(copy\)\)/)
  assert.match(source, /Math\.min\(MAX_FRAME_BYTES, end - start\)/)
  assert.match(source, /Unexpected text frame/)
})

test('relay handshake is private binary WSS and requires matching ready stream UUID', () => {
  assert.match(source, /"wss"\.equals\(uri\.getScheme\(\)\)/)
  assert.match(source, /"\/v1\/tunnel"\.equals\(uri\.getRawPath\(\)\)/)
  assert.match(source, /header\("X-Crow-Route", route\)/)
  assert.match(source, /header\("X-Crow-Role", "device"\)/)
  assert.match(source, /header\("X-Crow-Stream", streamId\)/)
  assert.match(source, /"ready"\.equals\(json\.optString\("type"\)\) && streamId\.equals\(json\.optString\("streamId"\)\)/)
  assert.match(source, /readyLatch\.await\(waitMillis, TimeUnit\.MILLISECONDS\)/)
  assert.match(source, /created\.cancel\(\)/)
  assert.doesNotMatch(source, /Authorization|Bearer|Crow JSON/)
})

test('SocketFactory overloads isolate each tunnel and use an injectable default-CA OkHttp client', () => {
  assert.match(source, /defaultCaClient/)
  assert.match(source, /default-CA client/)
  assert.match(source, /retryOnConnectionFailure\(false\)/)
  assert.match(source, /followRedirects\(false\)/)
  assert.match(source, /class Factory extends SocketFactory/)
  assert.match(source, /createSocket\(\)/)
  assert.match(source, /createSocket\(String host, int port\)/)
  assert.match(source, /createSocket\(String host, int port, InetAddress localHost, int localPort\)/)
  assert.match(source, /createSocket\(InetAddress host, int port\)/)
  assert.match(source, /createSocket\(InetAddress address, int port, InetAddress localAddress, int localPort\)/)
  assert.match(source, /UUID\.randomUUID\(\)/)
})
