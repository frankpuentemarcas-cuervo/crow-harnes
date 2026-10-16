import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomBytes, randomUUID } from 'node:crypto'
import net from 'node:net'
import { WebSocket } from 'ws'
import {
  createRelayServer,
  relayCapacityFromEnv,
  decodeStreamEnvelope,
  encodeStreamEnvelope,
  isValidRouteToken,
  MAX_FRAME_BYTES,
  MAX_CONNECTIONS,
  MAX_ROUTES,
  MAX_DEVICE_STREAMS_PER_ROUTE,
  parseGatewayControl
} from '../src/server.mjs'

const routeToken = () => randomBytes(32).toString('base64url')

test('reclaims a vanished device slot without closing healthy sibling or gateway', async t => {
  const relay = await fixture(t, { maxStreamsPerRoute: 2, heartbeatIntervalMs: 100 })
  if (!relay) return
  const route = routeToken(), gateway = relay.join(route, 'gateway')
  await waitOpen(gateway)
  gateway.on('message', (data, binary) => {
    if (!binary) { const message = JSON.parse(data); if (message.type === 'open') gateway.send(JSON.stringify({ type: 'accept', streamId: message.streamId })) }
  })
  const healthy = relay.join(route, 'device', randomUUID())
  const healthyReady = event(healthy, 'message', data => JSON.parse(data).type === 'ready')
  await healthyReady
  const vanished = new WebSocket(relay.url, { autoPong: false, headers: { 'X-Crow-Route': route, 'X-Crow-Role': 'device', 'X-Crow-Stream': randomUUID() } })
  vanished.on('error', () => {}); t.after(() => vanished.terminate())
  const ready = event(vanished, 'message', data => JSON.parse(data).type === 'ready')
  await ready
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay never reclaimed the vanished device slot')), 1500)
    vanished.once('close', () => { clearTimeout(timer); resolve() })
  })
  assert.equal(gateway.readyState, WebSocket.OPEN)
  assert.equal(healthy.readyState, WebSocket.OPEN)
  const deadline = Date.now() + 1000
  while (relay.routes.get(route).streams.size !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(relay.routes.get(route).streams.size, 1)
  const replacement = relay.join(route, 'device', randomUUID())
  await event(replacement, 'message', data => JSON.parse(data).type === 'ready')
  assert.equal(relay.routes.get(route).streams.size, 2)
})

test('validates canonical 32-byte route tokens and exact gateway control shape', () => {
  const route = routeToken()
  const streamId = randomUUID()
  assert.equal(isValidRouteToken(route), true)
  assert.equal(isValidRouteToken(`${route}=`), false)
  assert.equal(isValidRouteToken('a'.repeat(43)), false)
  assert.deepEqual(parseGatewayControl(JSON.stringify({ type: 'accept', streamId })), { type: 'accept', streamId })
  assert.equal(parseGatewayControl(JSON.stringify({ type: 'accept', streamId, extra: true })), null)
  assert.equal(parseGatewayControl(JSON.stringify({ type: 'open', streamId })), null)
})

test('uses a global single-user socket cap and rejects unsafe relay capacity overrides', () => {
  assert.equal(MAX_CONNECTIONS, 16 * (1 + 8))
  assert.throws(() => createRelayServer({ maxRoutes: 17 }), /capacity configuration/)
  assert.throws(() => createRelayServer({ maxStreamsPerRoute: 9 }), /capacity configuration/)
  assert.throws(() => createRelayServer({ maxPendingHandshakes: 33 }), /capacity configuration/)
  assert.throws(() => createRelayServer({ headersTimeoutMs: 5_001 }), /capacity configuration/)
})

test('entrypoint reads single-user route and stream limits from environment within safe maxima', () => {
  assert.deepEqual(relayCapacityFromEnv({ MAX_ROUTES: '2', MAX_DEVICE_STREAMS_PER_ROUTE: '4' }), { maxRoutes: 2, maxStreamsPerRoute: 4 })
  assert.deepEqual(relayCapacityFromEnv({}), { maxRoutes: MAX_ROUTES, maxStreamsPerRoute: MAX_DEVICE_STREAMS_PER_ROUTE })
  for (const env of [
    { MAX_ROUTES: '0' },
    { MAX_ROUTES: String(MAX_ROUTES + 1) },
    { MAX_ROUTES: '2.5' },
    { MAX_DEVICE_STREAMS_PER_ROUTE: '0' },
    { MAX_DEVICE_STREAMS_PER_ROUTE: String(MAX_DEVICE_STREAMS_PER_ROUTE + 1) },
    { MAX_DEVICE_STREAMS_PER_ROUTE: 'not-a-number' }
  ]) assert.throws(() => relayCapacityFromEnv(env), /Invalid relay capacity configuration/)
})

test('times out a partial HTTP upgrade header', async t => {
  const relay = await fixture(t, { headersTimeoutMs: 150, requestTimeoutMs: 150, connectionsCheckingIntervalMs: 25 })
  if (!relay) return

  const socket = await relay.rawConnect()
  const timeoutResponse = waitSocketData(socket, 2_000)
  const closed = waitSocketClose(socket, 2_000)
  socket.write('GET /v1/tunnel HTTP/1.1\r\nHost: localhost\r\nX-Crow-Role:')
  assert.match((await timeoutResponse).toString(), /^HTTP\/1\.1 408 /)
  await closed
})

test('bounds incomplete handshakes and releases a slot when a pending socket closes', async t => {
  const relay = await fixture(t, { maxPendingHandshakes: 1 })
  if (!relay) return

  const first = await relay.rawConnect()
  let excess
  let released
  first.write('GET /v1/tunnel HTTP/1.1\r\nHost: localhost\r\nX-Crow-Role:')
  excess = await relay.rawConnect()
  const excessClosed = waitSocketClose(excess, 2_000)
  if (!excess.destroyed && !excess.closed && excess.readyState !== 'closed') {
    excess.write('GET /v1/tunnel HTTP/1.1\r\nHost: localhost\r\n')
  }
  await excessClosed

  first.destroy()
  await waitSocketClose(first, 1_000)

  released = await relay.rawConnect()
  const response = waitSocketData(released, 2_000)
  released.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n')
  const data = await response
  assert.match(data.toString(), /^HTTP\/1\.1 204 /)
  assert.match(data.toString(), /connection: close/i)
  await waitSocketClose(released, 1_000)
})

test('rejects a WebSocket upgrade once the configured global connection ceiling is reached', async t => {
  const relay = await fixture(t, { maxRoutes: 1, maxStreamsPerRoute: 1 })
  if (!relay) return

  const route = routeToken()
  const gateway = relay.join(route, 'gateway')
  await waitOpen(gateway)

  const streamId = randomUUID()
  const opened = event(gateway, 'device open')
  const device = relay.join(route, 'device', streamId)
  await waitOpen(device)
  assert.deepEqual(JSON.parse((await opened).data.toString()), { type: 'open', streamId })

  const excess = relay.join(routeToken(), 'gateway')
  const rejectedUpgrade = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for capped upgrade rejection')), 2500)
    excess.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      resolve(response)
    })
    excess.once('open', () => {
      clearTimeout(timer)
      reject(new Error('relay accepted a WebSocket beyond the global connection ceiling'))
    })
    excess.once('error', () => {})
  })

  const response = await rejectedUpgrade
  assert.equal(response.statusCode, 503)
  assert.equal(response.headers.connection, 'close')
  assert.equal(response.headers['cache-control'], 'no-store')
  response.resume()
})

test('default profile accepts exactly 144 sockets and rejects socket 145', async t => {
  const relay = await fixture(t)
  if (!relay) return

  for (let routeIndex = 0; routeIndex < 16; routeIndex += 1) {
    const route = routeToken()
    const gateway = relay.join(route, 'gateway')
    await waitOpen(gateway)

    const opens = waitForTextMessages(gateway, 8, `8 stream-open controls for route ${routeIndex + 1}`)
    const streams = Array.from({ length: 8 }, () => {
      const device = relay.join(route, 'device', randomUUID())
      return { device, opened: waitOpen(device) }
    })
    await Promise.all(streams.map(stream => stream.opened))
    await opens
  }

  assert.equal(relay.routes.size, 16)
  for (const route of relay.routes.values()) {
    assert.ok(route.gateway)
    assert.equal(route.gateway.readyState, WebSocket.OPEN)
    assert.equal(route.streams.size, 8)
    assert.ok([...route.streams.values()].every(stream => stream.device.readyState === WebSocket.OPEN))
  }

  const excess = relay.join(routeToken(), 'gateway')
  const response = await waitForRejectedUpgrade(excess)
  assert.equal(response.statusCode, 503)
  assert.equal(response.headers.connection, 'close')
  assert.equal(response.headers['cache-control'], 'no-store')
  response.resume()
})

test('encodes and decodes the exact opaque CHT1 plus canonical UUID envelope', () => {
  const streamId = randomUUID()
  const payload = Buffer.from([0x16, 0x03, 0x03, 0x00, 0xff])
  const bytes = encodeStreamEnvelope(streamId, payload)
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'CHT1')
  assert.equal(bytes.subarray(4, 40).toString('ascii'), streamId)
  assert.deepEqual(decodeStreamEnvelope(bytes), { streamId, payload })
  assert.equal(decodeStreamEnvelope(Buffer.from('bad envelope')), null)
})
const connect = (url, route, role, streamId) => new WebSocket(url, {
  headers: {
    'X-Crow-Route': route,
    'X-Crow-Role': role,
    ...(streamId ? { 'X-Crow-Stream': streamId } : {})
  },
  perMessageDeflate: false,
  maxPayload: MAX_FRAME_BYTES
})

function event(ws, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${name}`)) }, 2500)
    const onMessage = (data, isBinary) => {
      if (!predicate(data, isBinary)) return
      cleanup()
      resolve({ data, isBinary })
    }
    const onError = error => { cleanup(); reject(error) }
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('error', onError) }
    ws.on('message', onMessage)
    ws.once('error', onError)
  })
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
}

function waitForTextMessages(ws, expectedCount, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${label}`)) }, 15_000)
    let count = 0
    const onMessage = (_data, isBinary) => {
      if (isBinary) return
      count += 1
      if (count === expectedCount) { cleanup(); resolve() }
    }
    const onError = error => { cleanup(); reject(error) }
    const cleanup = () => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('error', onError)
    }
    ws.on('message', onMessage)
    ws.once('error', onError)
  })
}

function waitForRejectedUpgrade(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for capped upgrade rejection')) }, 15_000)
    const onResponse = (_request, response) => { cleanup(); resolve(response) }
    const onOpen = () => { cleanup(); reject(new Error('relay accepted a WebSocket beyond the global connection ceiling')) }
    const onError = () => {}
    const cleanup = () => {
      clearTimeout(timer)
      ws.off('unexpected-response', onResponse)
      ws.off('open', onOpen)
      ws.off('error', onError)
    }
    ws.once('unexpected-response', onResponse)
    ws.once('open', onOpen)
    ws.on('error', onError)
  })
}

async function fixture(t, options) {
  const relay = createRelayServer(options)
  let address
  try { address = await relay.listen(0, '127.0.0.1') } catch (error) {
    if (error.code === 'EACCES') { t.skip('local loopback sockets are unavailable in this environment'); return null }
    throw error
  }
  const clients = new Set()
  const rawSockets = new Set()
  t.after(async () => {
    for (const ws of clients) ws.terminate()
    for (const socket of rawSockets) socket.destroy()
    await relay.close()
  })
  return {
    url: `ws://127.0.0.1:${address.port}/v1/tunnel`,
    port: address.port,
    routes: relay.routes,
    rawConnect() { return rawConnect(address.port, rawSockets) },
    join(route, role, streamId) {
      const ws = connect(`ws://127.0.0.1:${address.port}/v1/tunnel`, route, role, streamId)
      ws.on('error', () => {})
      clients.add(ws)
      return ws
    }
  }
}

function rawConnect(port, sockets) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      sockets.add(socket)
      socket.once('close', () => { socket.__relayClosed = true; sockets.delete(socket) })
      resolve(socket)
    })
    socket.once('close', () => { socket.__relayClosed = true })
    socket.once('error', reject)
  })
}

function waitSocketClose(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed || socket.closed || socket.__relayClosed || socket.readyState === 'closed') return resolve()
    const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for TCP socket close')) }, timeoutMs)
    const cleanup = () => { clearTimeout(timer); socket.off('close', onClose); socket.off('error', onError) }
    const onClose = () => { cleanup(); resolve() }
    const onError = error => { if (error.code === 'ECONNRESET') return; cleanup(); reject(error) }
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

function waitSocketData(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for HTTP response')) }, timeoutMs)
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError) }
    const onData = chunk => { chunks.push(chunk); if (Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) { cleanup(); resolve(Buffer.concat(chunks)) } }
    const onError = error => { cleanup(); reject(error) }
    socket.on('data', onData)
    socket.once('error', onError)
  })
}

test('exposes only a minimal uncached GET /healthz readiness response', async t => {
  const relay = createRelayServer()
  let address
  try { address = await relay.listen(0, '127.0.0.1') } catch (error) {
    if (error.code === 'EACCES') { t.skip('local loopback sockets are unavailable in this environment'); return }
    throw error
  }
  t.after(() => relay.close())
  const base = `http://127.0.0.1:${address.port}`

  const health = await fetch(`${base}/healthz`)
  assert.equal(health.status, 204)
  assert.equal(health.headers.get('cache-control'), 'no-store')
  assert.equal(await health.text(), '')
  assert.equal(health.headers.get('content-type'), null)

  for (const [path, method] of [['/healthz', 'POST'], ['/health', 'GET'], ['/v1/tunnel', 'GET']]) {
    const response = await fetch(`${base}${path}`, { method })
    assert.equal(response.status, 404, `${method} ${path} must remain unavailable`)
    assert.equal(await response.text(), 'not found')
  }
})

test('routes accepted streams and forwards only opaque bytes with CHT1 UUID envelope', async t => {
  const relay = await fixture(t)
  if (!relay) return
  const route = routeToken()
  const streamId = randomUUID()
  const gateway = relay.join(route, 'gateway')
  await waitOpen(gateway)
  const opened = event(gateway, 'message')
  const device = relay.join(route, 'device', streamId)
  await waitOpen(device)
  const open = await opened
  assert.equal(open.isBinary, false)
  assert.deepEqual(JSON.parse(open.data.toString()), { type: 'open', streamId })

  const ready = event(device, 'message')
  gateway.send(JSON.stringify({ type: 'accept', streamId }))
  assert.deepEqual(JSON.parse((await ready).data.toString()), { type: 'ready', streamId })

  const tlsBytes = Buffer.from([0x16, 0x03, 0x03, 0x00, 0xff, 0x00, 0x80])
  const fromDevice = event(gateway, 'message', (_data, binary) => binary)
  device.send(tlsBytes, { binary: true, compress: false })
  const wrapped = (await fromDevice).data
  assert.equal(wrapped.subarray(0, 4).toString('ascii'), 'CHT1')
  assert.equal(wrapped.subarray(4, 40).toString('ascii'), streamId)
  assert.deepEqual(wrapped.subarray(40), tlsBytes)

  const fromGateway = event(device, 'message', (_data, binary) => binary)
  gateway.send(Buffer.concat([Buffer.from('CHT1'), Buffer.from(streamId), tlsBytes]), { binary: true, compress: false })
  assert.deepEqual((await fromGateway).data, tlsBytes)
})

test('rejects unavailable, duplicate gateway, invalid path, and duplicate stream without exposing route state', async t => {
  const relay = await fixture(t)
  if (!relay) return
  const route = routeToken()
  const unavailable = relay.join(route, 'device', randomUUID())
  const unavailableError = event(unavailable, 'message')
  await waitOpen(unavailable)
  assert.deepEqual(JSON.parse((await unavailableError).data.toString()), { type: 'error', code: 'unavailable' })

  const gateway = relay.join(route, 'gateway')
  await waitOpen(gateway)
  const duplicate = relay.join(route, 'gateway')
  const duplicateError = event(duplicate, 'message')
  await waitOpen(duplicate)
  assert.deepEqual(JSON.parse((await duplicateError).data.toString()), { type: 'error', code: 'unavailable' })

  const streamId = randomUUID()
  const open = event(gateway, 'message')
  const device = relay.join(route, 'device', streamId)
  await waitOpen(device)
  assert.deepEqual(JSON.parse((await open).data.toString()), { type: 'open', streamId })
  const duplicateStream = relay.join(route, 'device', streamId)
  const duplicateStreamError = event(duplicateStream, 'message')
  await waitOpen(duplicateStream)
  assert.deepEqual(JSON.parse((await duplicateStreamError).data.toString()), { type: 'error', code: 'unavailable' })

  const badPath = new WebSocket(relay.url + '?room=enumeration', {
    headers: { 'X-Crow-Route': route, 'X-Crow-Role': 'gateway' }
  })
  await assert.rejects(waitOpen(badPath))
})

test('reject, timeout, and device stream limits are bounded and clean state', async t => {
  const relay = await fixture(t, { maxStreamsPerRoute: 1, openTimeoutMs: 100 })
  if (!relay) return
  const route = routeToken()
  const gateway = relay.join(route, 'gateway')
  await waitOpen(gateway)

  const firstId = randomUUID()
  const firstOpen = event(gateway, 'first open')
  const first = relay.join(route, 'device', firstId)
  const timeoutError = event(first, 'timeout error')
  await waitOpen(first)
  assert.deepEqual(JSON.parse((await firstOpen).data.toString()), { type: 'open', streamId: firstId })
  const limited = relay.join(route, 'device', randomUUID())
  const limitError = event(limited, 'limit error')
  await waitOpen(limited)
  assert.deepEqual(JSON.parse((await limitError).data.toString()), { type: 'error', code: 'limit' })
  assert.deepEqual(JSON.parse((await timeoutError).data.toString()), { type: 'error', code: 'timeout' })

  const rejectedId = randomUUID()
  const rejectedOpen = event(gateway, 'rejected open')
  const rejected = relay.join(route, 'device', rejectedId)
  const rejectedError = event(rejected, 'rejection error')
  await waitOpen(rejected)
  assert.deepEqual(JSON.parse((await rejectedOpen).data.toString()), { type: 'open', streamId: rejectedId })
  gateway.send(JSON.stringify({ type: 'reject', streamId: rejectedId }))
  assert.deepEqual(JSON.parse((await rejectedError).data.toString()), { type: 'error', code: 'rejected' })
})

test('caps route count and rejects malformed binary envelopes', async t => {
  const relay = await fixture(t, { maxRoutes: 1 })
  if (!relay) return
  const firstRoute = routeToken()
  const gateway = relay.join(firstRoute, 'gateway')
  await waitOpen(gateway)
  const secondGateway = relay.join(routeToken(), 'gateway')
  const fullError = event(secondGateway, 'message')
  await waitOpen(secondGateway)
  assert.deepEqual(JSON.parse((await fullError).data.toString()), { type: 'error', code: 'unavailable' })

  const streamId = randomUUID()
  const opened = event(gateway, 'message')
  const device = relay.join(firstRoute, 'device', streamId)
  await waitOpen(device)
  await opened
  const ready = event(device, 'message')
  gateway.send(JSON.stringify({ type: 'accept', streamId }))
  await ready
  const protocolError = event(gateway, 'message')
  gateway.send(Buffer.from('not an envelope'), { binary: true })
  assert.deepEqual(JSON.parse((await protocolError).data.toString()), { type: 'error', code: 'protocol' })
})
