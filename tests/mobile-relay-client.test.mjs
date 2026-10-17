import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import forge from 'node-forge'
import { createRelayServer } from '../packages/mobile-relay/src/server.mjs'
import { MobileRelayClient } from '../src/main/mobile-relay-client.ts'

const routeId = 'A'.repeat(43)

function makeCertificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = Date.now().toString(16)
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 60 * 60_000)
  cert.setSubject([{ name: 'commonName', value: 'localhost' }])
  cert.setIssuer([{ name: 'commonName', value: 'localhost' }])
  cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) }
}

async function eventually(predicate, message = 'condition not reached') {
  const until = Date.now() + 2500
  while (Date.now() < until) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

async function makeHarness({ onConnection, tcpHandler, reconnectMinMs = 20 } = {}) {
  const tls = makeCertificate()
  const https = createHttpsServer(tls)
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  https.on('upgrade', (request, socket, head) => {
    if (request.url !== '/v1/tunnel') return socket.destroy()
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  })
  if (onConnection) wss.on('connection', onConnection)
  else wss.on('connection', ws => ws.on('message', () => {}))
  await new Promise(resolve => https.listen(0, '127.0.0.1', resolve))

  const tcp = createTcpServer(socket => tcpHandler?.(socket))
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve))
  const client = new MobileRelayClient({
    url: `wss://127.0.0.1:${https.address().port}/v1/tunnel`, routeId, localPort: tcp.address().port,
    reconnectMinMs, reconnectMaxMs: 80, heartbeatIntervalMs: 200,
    random: () => 0,
    webSocketFactory: (url, options) => new WebSocket(url, { ...options, rejectUnauthorized: false })
  })
  return {
    client, https, wss, tcp,
    async close() {
      client.stop()
      for (const ws of wss.clients) ws.terminate()
      tcp.closeAllConnections?.()
      https.closeAllConnections?.()
      wss.close()
      https.close()
      tcp.close()
    }
  }
}

function waitMessage(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 2500)
    const listener = (data, binary) => {
      if (!predicate(data, binary)) return
      clearTimeout(timer)
      ws.off('message', listener)
      resolve({ data: Buffer.from(data), binary })
    }
    ws.on('message', listener)
  })
}

function sendControl(ws, value) { ws.send(JSON.stringify(value)) }
function sendEnvelope(ws, id, data) { ws.send(Buffer.concat([Buffer.from('CHT1'), Buffer.from(id), data]), { binary: true, compress: false }) }

for (const reconnect of [false, true]) {
  test(`stop safely aborts a real CONNECTING WebSocket during ${reconnect ? 'reconnect' : 'initial connection'}`, () => {
    // Isolate the real ws next-tick error: an unhandled shutdown error must crash
    // the child, not be swallowed by a process-wide uncaughtException handler.
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { strict as assert } from 'node:assert'
      import { WebSocket } from 'ws'
      import { MobileRelayClient } from ${JSON.stringify(new URL('../src/main/mobile-relay-client.ts', import.meta.url).href)}
      const sockets = []
      const client = new MobileRelayClient({
        url: 'wss://127.0.0.1:1/v1/tunnel', routeId: 'A'.repeat(43), localPort: 1,
        reconnectMinMs: 1, random: () => 0,
        webSocketFactory: (url, options) => {
          const ws = new WebSocket(url.replace(/^wss:/, 'ws:'), options)
          sockets.push(ws)
          if (${reconnect} && sockets.length === 2) queueMicrotask(stopConnecting)
          return ws
        }
      })
      function stopConnecting() {
        assert.equal(sockets.at(-1).readyState, WebSocket.CONNECTING)
        assert.equal(client.status().state, ${JSON.stringify(reconnect ? 'reconnecting' : 'connecting')})
        client.stop()
        client.stop()
      }
      client.start()
      // Abort before any network I/O. In reconnect mode the first abort is a
      // transport disconnect, so it schedules a genuine second connection.
      if (${reconnect}) sockets[0].close()
      else stopConnecting()
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(client.status().state, 'stopped')
      assert.equal(client.status().activeStreams, 0)
      assert.equal(sockets.length, ${reconnect ? 2 : 1})
      assert.ok(sockets.every(ws => ws.readyState === WebSocket.CLOSED))
      assert.equal(sockets.at(-1).listenerCount('error'), 0)
      assert.equal(sockets.at(-1).listenerCount('close'), 0)
    `], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
}

test('stop is idempotent and stale shutdown events cannot affect a restarted client', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: Date.now() })
  class ControlledWebSocket extends EventEmitter {
    readyState = WebSocket.CONNECTING
    closes = 0
    pings = 0
    close() {
      this.closes += 1
      const connecting = this.readyState === WebSocket.CONNECTING
      this.readyState = WebSocket.CLOSING
      queueMicrotask(() => {
        if (connecting) this.emit('error', new Error('WebSocket was closed before the connection was established'))
        this.readyState = WebSocket.CLOSED
        this.emit('close', 1006)
      })
    }
    terminate() { this.close() }
    ping() { this.pings += 1; this.emit('pong') }
  }
  const sockets = []
  const client = new MobileRelayClient({
    url: 'wss://127.0.0.1/v1/tunnel', routeId, localPort: 1,
    heartbeatIntervalMs: 50, reconnectMinMs: 1,
    webSocketFactory: () => {
      const ws = new ControlledWebSocket()
      sockets.push(ws)
      return ws
    }
  })
  t.after(() => client.stop())
  client.start()
  const first = sockets[0]
  client.stop()
  client.stop()
  assert.equal(first.closes, 1)
  assert.equal(client.status().state, 'stopped')
  client.start()
  const second = sockets[1]
  // These events arrive from the retired transport before its close event.
  first.emit('open')
  first.emit('pong')
  first.emit('message', Buffer.from('invalid late control'), false)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(first.eventNames(), [])
  assert.equal(client.status().state, 'connecting')
  assert.equal(client.status().reconnectAttempts, 0)
  second.readyState = WebSocket.OPEN
  second.emit('open')
  t.mock.timers.tick(50)
  assert.equal(second.pings, 1)
  client.stop()
  client.stop()
  const pings = second.pings
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(150)
  assert.equal(second.closes, 1)
  assert.equal(second.pings, pings)
  assert.deepEqual(second.eventNames(), [])
  assert.equal(sockets.length, 2)
  assert.equal(client.status().state, 'stopped')
})

test('opens a fixed local TCP stream and accepts only after connect, then routes binary data both ways', async t => {
  let tcpPeer
  let tcpData = Buffer.alloc(0)
  let relayReceived
  const harness = await makeHarness({
    tcpHandler: socket => { tcpPeer = socket; socket.on('data', data => { tcpData = Buffer.concat([tcpData, data]) }) },
    onConnection: (ws, req) => {
      assert.equal(req.headers['x-crow-route'], routeId)
      assert.equal(req.headers['x-crow-role'], 'gateway')
      ws.on('message', (data, binary) => { if (binary) relayReceived = Buffer.from(data) })
    }
  })
  t.after(() => harness.close())
  harness.client.start()
  const ws = await new Promise(resolve => harness.wss.once('connection', resolve))
  await eventually(() => harness.client.status().state === 'connected')
  const id = randomUUID()
  const accepted = waitMessage(ws, (data, binary) => !binary && JSON.parse(data.toString()).type === 'accept')
  sendControl(ws, { type: 'open', streamId: id })
  assert.deepEqual(JSON.parse((await accepted).data.toString()), { type: 'accept', streamId: id })
  const roundTrip = waitMessage(ws, (_data, binary) => binary)
  tcpPeer.write('reply from local service')
  const localEnvelope = (await roundTrip).data
  assert.equal(localEnvelope.subarray(0, 4).toString(), 'CHT1')
  assert.equal(localEnvelope.subarray(40).toString(), 'reply from local service')
  await eventually(() => relayReceived?.subarray(40).toString() === 'reply from local service')
  sendEnvelope(ws, id, Buffer.from('request payload'))
  await eventually(() => tcpData.toString() === 'request payload')
})

test('desktop connector and actual broker exchange bounded opaque TLS bytes and close the same stream', async t => {
  const relay = createRelayServer({ maxRoutes: 1, maxStreamsPerRoute: 1, openTimeoutMs: 1000 })
  const relayAddress = await relay.listen(0, '127.0.0.1')
  const tcp = createTcpServer(socket => socket.on('data', data => socket.write(data)))
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve))
  const routeId = Buffer.alloc(32, 7).toString('base64url')
  const gateway = new MobileRelayClient({
    url: `wss://127.0.0.1:${relayAddress.port}/v1/tunnel`, routeId, localPort: tcp.address().port,
    heartbeatIntervalMs: 500, webSocketFactory: (url, options) => new WebSocket(url.replace(/^wss:/, 'ws:'), options)
  })
  const deviceId = randomUUID()
  let device
  t.after(async () => {
    gateway.stop(); device?.terminate(); tcp.closeAllConnections?.(); await relay.close()
    await new Promise(resolve => tcp.close(resolve))
  })
  gateway.start()
  await eventually(() => gateway.status().state === 'connected')
  device = new WebSocket(`ws://127.0.0.1:${relayAddress.port}/v1/tunnel`, { headers: { 'X-Crow-Route': routeId, 'X-Crow-Role': 'device', 'X-Crow-Stream': deviceId }, perMessageDeflate: false })
  const ready = waitMessage(device, (data, binary) => !binary && JSON.parse(data.toString()).type === 'ready')
  await new Promise((resolve, reject) => { device.once('open', resolve); device.once('error', reject) })
  assert.deepEqual(JSON.parse((await ready).data.toString()), { type: 'ready', streamId: deviceId })
  const tlsPayload = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x05, 1, 2, 3, 4, 5])
  const echo = waitMessage(device, (_data, binary) => binary)
  device.send(tlsPayload, { binary: true, compress: false })
  assert.deepEqual((await echo).data, tlsPayload)
  const closed = new Promise(resolve => device.once('close', resolve))
  device.close()
  await closed
  await eventually(() => gateway.status().activeStreams === 0)
})

test('relay ignores late frames for a retired stream without disconnecting other devices', async t => {
  const relay = createRelayServer({ maxRoutes: 1, maxStreamsPerRoute: 2, openTimeoutMs: 1000 })
  const address = await relay.listen(0, '127.0.0.1')
  const route = Buffer.alloc(32, 9).toString('base64url')
  const gateway = new WebSocket(`ws://127.0.0.1:${address.port}/v1/tunnel`, { headers: { 'X-Crow-Route': route, 'X-Crow-Role': 'gateway' } })
  const firstId = randomUUID(), secondId = randomUUID()
  let first, second
  t.after(async () => { gateway.terminate(); first?.terminate(); second?.terminate(); await relay.close() })
  await new Promise((resolve, reject) => { gateway.once('open', resolve); gateway.once('error', reject) })
  const opens = new Set()
  gateway.on('message', (data, binary) => { if (!binary) { const message = JSON.parse(data.toString()); if (message.type === 'open') { opens.add(message.streamId); sendControl(gateway, { type: 'accept', streamId: message.streamId }) } } })
  first = new WebSocket(`ws://127.0.0.1:${address.port}/v1/tunnel`, { headers: { 'X-Crow-Route': route, 'X-Crow-Role': 'device', 'X-Crow-Stream': firstId } })
  second = new WebSocket(`ws://127.0.0.1:${address.port}/v1/tunnel`, { headers: { 'X-Crow-Route': route, 'X-Crow-Role': 'device', 'X-Crow-Stream': secondId } })
  await Promise.all([first, second].map(ws => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })))
  await eventually(() => opens.size === 2)
  await eventually(() => first.readyState === WebSocket.OPEN && second.readyState === WebSocket.OPEN)
  const firstClosed = new Promise(resolve => first.once('close', resolve))
  first.close()
  await firstClosed
  await eventually(() => !relay.routes.get(route)?.streams.has(firstId))
  sendControl(gateway, { type: 'close', streamId: firstId })
  sendEnvelope(gateway, firstId, Buffer.from('late data'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(gateway.readyState, WebSocket.OPEN)
  assert.equal(second.readyState, WebSocket.OPEN)
  assert.equal(relay.routes.get(route)?.streams.has(secondId), true)
})

test('rejects wrong route credentials and refuses non-WSS or wrong-path configuration', async t => {
  const tls = makeCertificate()
  const https = createHttpsServer(tls)
  const wss = new WebSocketServer({ noServer: true })
  https.on('upgrade', (req, socket, head) => {
    if (req.headers['x-crow-route'] !== routeId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
  await new Promise(resolve => https.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => https.close(resolve)) })
  assert.throws(() => new MobileRelayClient({ url: 'ws://127.0.0.1/v1/tunnel', routeId, localPort: 1 }), /wss/)
  assert.throws(() => new MobileRelayClient({ url: 'wss://127.0.0.1/other', routeId, localPort: 1 }), /wss/)
  // A broker rejects a validly-shaped but unrecognized route, without exposing its response details.
  const client = new MobileRelayClient({
    url: `wss://127.0.0.1:${https.address().port}/v1/tunnel`, routeId: 'B'.repeat(43), localPort: 1234,
    reconnectMinMs: 1000, webSocketFactory: (url, options) => new WebSocket(url, { ...options, rejectUnauthorized: false })
  })
  client.start()
  await eventually(() => client.status().state === 'reconnecting')
  client.stop()
})

test('closes the relay connection on unknown and malformed stream envelopes', async t => {
  const harness = await makeHarness()
  t.after(() => harness.close())
  harness.client.start()
  const ws = await new Promise(resolve => harness.wss.once('connection', resolve))
  await eventually(() => harness.client.status().state === 'connected')
  const closed = new Promise(resolve => ws.once('close', resolve))
  sendEnvelope(ws, randomUUID(), Buffer.from('orphan'))
  const code = await closed
  assert.ok(code === 1008 || code === 1006)
  await eventually(() => harness.client.status().activeStreams === 0)
})

test('desktop connector drops late close/data for a retired stream but keeps gateway alive', async t => {
  const harness = await makeHarness({ tcpHandler: socket => socket.on('data', () => {}) })
  t.after(() => harness.close())
  harness.client.start()
  const ws = await new Promise(resolve => harness.wss.once('connection', resolve))
  await eventually(() => harness.client.status().state === 'connected')
  const firstId = randomUUID()
  const accepted = waitMessage(ws, (data, binary) => !binary && JSON.parse(data.toString()).type === 'accept')
  sendControl(ws, { type: 'open', streamId: firstId })
  await accepted
  sendControl(ws, { type: 'close', streamId: firstId })
  await eventually(() => harness.client.status().activeStreams === 0)
  sendControl(ws, { type: 'close', streamId: firstId })
  sendEnvelope(ws, firstId, Buffer.from('late data'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(ws.readyState, WebSocket.OPEN)
  assert.equal(harness.client.status().state, 'connected')
  const secondId = randomUUID()
  const secondAccepted = waitMessage(ws, (data, binary) => !binary && JSON.parse(data.toString()).type === 'accept')
  sendControl(ws, { type: 'open', streamId: secondId })
  await secondAccepted
  assert.equal(harness.client.status().activeStreams, 1)
})

test('enforces 8 active streams and caps queued TCP bytes per stream', async t => {
  const harness = await makeHarness({ tcpHandler: socket => { socket.pause() } })
  t.after(() => harness.close())
  harness.client.start()
  const ws = await new Promise(resolve => harness.wss.once('connection', resolve))
  await eventually(() => harness.client.status().state === 'connected')
  const ids = Array.from({ length: 9 }, () => randomUUID())
  const rejects = []
  let accepts = 0
  ws.on('message', (data, binary) => {
    if (binary) return
    const message = JSON.parse(data.toString())
    if (message.type === 'reject') rejects.push(data)
    if (message.type === 'accept') accepts += 1
  })
  for (const id of ids) sendControl(ws, { type: 'open', streamId: id })
  await eventually(() => harness.client.status().activeStreams === 8)
  await eventually(() => ws.readyState === WebSocket.OPEN)
  await eventually(() => rejects.length === 1)
  await eventually(() => accepts === 8)

  const victim = ids[0]
  // Queue enough legal-sized frames against a paused local socket to cross 1 MiB.
  for (let i = 0; i < 96; i++) sendEnvelope(ws, victim, Buffer.alloc(60 * 1024, 7))
  await eventually(() => harness.client.status().activeStreams < 8, 'per-stream queued-byte cap did not close stream')
})

test('disconnects cleanly, reconnects with jitter, and stop prevents later reconnects', async t => {
  const harness = await makeHarness()
  t.after(() => harness.close())
  let connections = 0
  harness.wss.on('connection', () => { connections += 1 })
  harness.client.start()
  await eventually(() => connections === 1)
  const first = [...harness.wss.clients][0]
  first.terminate()
  await eventually(() => harness.client.status().reconnectAttempts >= 1)
  await eventually(() => harness.client.status().lastDisconnect?.cause === 'socket-close')
  assert.equal(harness.client.status().lastDisconnect?.code, 1006)
  await eventually(() => connections >= 2)
  assert.equal(harness.client.status().activeStreams, 0)
  harness.client.stop()
  const count = connections
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(connections, count)
  assert.equal(harness.client.status().state, 'stopped')
  assert.equal(harness.client.status().activeStreams, 0)
  assert.equal(typeof harness.client.status().reconnectAttempts, 'number')
  assert.equal(harness.client.status().lastDisconnect?.cause, 'socket-close')
})
