import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

export const RELAY_PATH = '/v1/tunnel'
export const MAX_FRAME_BYTES = 64 * 1024
export const MAX_ROUTES = 16
export const MAX_DEVICE_STREAMS_PER_ROUTE = 8
export const MAX_BUFFERED_BYTES = 128 * 1024
export const OPEN_TIMEOUT_MS = 10_000
export const MAX_CONNECTIONS = MAX_ROUTES * (1 + MAX_DEVICE_STREAMS_PER_ROUTE)
export const MAX_PENDING_HANDSHAKES = 32
export const MAX_HEADERS_TIMEOUT_MS = 5_000
export const MAX_REQUEST_TIMEOUT_MS = 10_000
export const MAX_CONNECTIONS_CHECK_INTERVAL_MS = 1_000
const MAX_HEADER_BYTES = 8 * 1024
const MAX_HEADER_COUNT = 32

function boundedEnvInteger(env, name, fallback, maximum) {
  const raw = env[name]
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) throw new Error('Invalid relay capacity configuration')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error('Invalid relay capacity configuration')
  return value
}

export function relayCapacityFromEnv(env = process.env) {
  return {
    maxRoutes: boundedEnvInteger(env, 'MAX_ROUTES', MAX_ROUTES, MAX_ROUTES),
    maxStreamsPerRoute: boundedEnvInteger(env, 'MAX_DEVICE_STREAMS_PER_ROUTE', MAX_DEVICE_STREAMS_PER_ROUTE, MAX_DEVICE_STREAMS_PER_ROUTE)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROUTE = /^[A-Za-z0-9_-]{43}$/
const ENVELOPE_MAGIC = Buffer.from('CHT1', 'ascii')
const ENVELOPE_BYTES = 4 + 36

function routeIsValid(value) {
  if (typeof value !== 'string' || !ROUTE.test(value)) return false
  try {
    const bytes = Buffer.from(value, 'base64url')
    return bytes.length === 32 && bytes.toString('base64url') === value
  } catch {
    return false
  }
}

export const isValidRouteToken = routeIsValid

function header(req, name) {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function genericError(code) {
  return JSON.stringify({ type: 'error', code })
}

function sendText(ws, value) {
  if (ws.readyState !== WebSocket.OPEN) return false
  if (ws.bufferedAmount + Buffer.byteLength(value) > MAX_BUFFERED_BYTES) {
    ws.terminate()
    return false
  }
  ws.send(value, { compress: false }, error => { if (error) ws.terminate() })
  return true
}

function sendBinary(ws, value) {
  if (ws.readyState !== WebSocket.OPEN) return false
  if (ws.bufferedAmount + value.length > MAX_BUFFERED_BYTES) {
    ws.terminate()
    return false
  }
  ws.send(value, { binary: true, compress: false }, error => { if (error) ws.terminate() })
  return true
}

function fail(ws, code) {
  sendText(ws, genericError(code))
  if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'relay error')
}

function envelope(streamId, bytes) {
  return Buffer.concat([ENVELOPE_MAGIC, Buffer.from(streamId, 'ascii'), bytes])
}

export const encodeStreamEnvelope = envelope

function parseEnvelope(data) {
  const bytes = Buffer.from(data)
  if (bytes.length < ENVELOPE_BYTES || !bytes.subarray(0, 4).equals(ENVELOPE_MAGIC)) return null
  const streamId = bytes.subarray(4, ENVELOPE_BYTES).toString('ascii')
  if (!UUID.test(streamId)) return null
  return { streamId, payload: bytes.subarray(ENVELOPE_BYTES) }
}

export const decodeStreamEnvelope = parseEnvelope

function clearPending(stream) {
  if (stream.timer) clearTimeout(stream.timer)
  stream.timer = undefined
}

function detachStream(route, streamId, notifyGateway = false, closeDevice = true) {
  const stream = route?.streams.get(streamId)
  if (!stream) return
  clearPending(stream)
  route.streams.delete(streamId)
  if (notifyGateway && route.gateway?.readyState === WebSocket.OPEN) {
    sendText(route.gateway, JSON.stringify({ type: 'close', streamId }))
  }
  if (closeDevice && stream.device.readyState === WebSocket.OPEN) stream.device.close(1000, 'stream closed')
}

function parseControl(text) {
  try {
    const message = JSON.parse(text)
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null
    if (typeof message.streamId !== 'string' || !UUID.test(message.streamId)) return null
    if (message.type === 'accept' || message.type === 'reject' || message.type === 'close') {
      if (Object.keys(message).length !== 2) return null
      return message
    }
  } catch {}
  return null
}

export const parseGatewayControl = parseControl

export function createRelayServer({
  maxRoutes = MAX_ROUTES,
  maxStreamsPerRoute = MAX_DEVICE_STREAMS_PER_ROUTE,
  openTimeoutMs = OPEN_TIMEOUT_MS,
  maxPendingHandshakes = MAX_PENDING_HANDSHAKES,
  headersTimeoutMs = MAX_HEADERS_TIMEOUT_MS,
  requestTimeoutMs = MAX_REQUEST_TIMEOUT_MS,
  connectionsCheckingIntervalMs = MAX_CONNECTIONS_CHECK_INTERVAL_MS
} = {}) {
  if (!Number.isInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > MAX_ROUTES ||
      !Number.isInteger(maxStreamsPerRoute) || maxStreamsPerRoute < 1 || maxStreamsPerRoute > MAX_DEVICE_STREAMS_PER_ROUTE ||
      !Number.isInteger(openTimeoutMs) || openTimeoutMs < 100 || openTimeoutMs > OPEN_TIMEOUT_MS ||
      !Number.isInteger(maxPendingHandshakes) || maxPendingHandshakes < 1 || maxPendingHandshakes > MAX_PENDING_HANDSHAKES ||
      !Number.isInteger(headersTimeoutMs) || headersTimeoutMs < 100 || headersTimeoutMs > MAX_HEADERS_TIMEOUT_MS ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS ||
      !Number.isInteger(connectionsCheckingIntervalMs) || connectionsCheckingIntervalMs < 10 || connectionsCheckingIntervalMs > MAX_CONNECTIONS_CHECK_INTERVAL_MS) {
    throw new Error('Invalid relay capacity configuration')
  }
  const maxConnections = maxRoutes * (1 + maxStreamsPerRoute)
  const routes = new Map()
  const pendingHandshakes = new Set()
  const releaseHandshake = socket => { pendingHandshakes.delete(socket) }
  const httpServer = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    releaseHandshake(req.socket)
    res.shouldKeepAlive = false
    res.setHeader('connection', 'close')
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    res.end('not found')
  })
  httpServer.headersTimeout = headersTimeoutMs
  httpServer.requestTimeout = requestTimeoutMs
  httpServer.connectionsCheckingInterval = connectionsCheckingIntervalMs
  httpServer.maxHeadersCount = MAX_HEADER_COUNT
  // Upgraded WSS clients and pending/non-upgraded TCP sockets use separate limits.
  // Leave enough TCP slots for the 145th WSS attempt to receive the broker's 503.
  httpServer.maxConnections = maxConnections + maxPendingHandshakes
  httpServer.on('connection', socket => {
    if (pendingHandshakes.size >= maxPendingHandshakes) {
      socket.destroy()
      return
    }
    pendingHandshakes.add(socket)
    socket.once('close', () => releaseHandshake(socket))
    socket.once('error', () => releaseHandshake(socket))
  })
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    clientTracking: true
  })

  const removeRouteIfEmpty = (routeKey, route) => {
    if (!route.gateway && route.streams.size === 0 && routes.get(routeKey) === route) routes.delete(routeKey)
  }

  const closeRoute = (routeKey, route) => {
    if (route.gateway) {
      const gateway = route.gateway
      route.gateway = null
      if (gateway.readyState === WebSocket.OPEN) gateway.close(1001, 'route closed')
    }
    for (const streamId of route.streams.keys()) {
      const stream = route.streams.get(streamId)
      clearPending(stream)
      route.streams.delete(streamId)
      if (stream.device.readyState === WebSocket.OPEN) fail(stream.device, 'unavailable')
    }
    removeRouteIfEmpty(routeKey, route)
  }

  httpServer.on('upgrade', (req, socket, head) => {
    releaseHandshake(socket)
    const requestPath = req.url
    const routeKey = header(req, 'x-crow-route')
    const role = header(req, 'x-crow-role')
    const streamId = header(req, 'x-crow-stream')
    if (requestPath !== RELAY_PATH || !routeIsValid(routeKey) || (role !== 'gateway' && role !== 'device') ||
        (role === 'device' ? typeof streamId !== 'string' || !UUID.test(streamId) : streamId !== undefined)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n')
      socket.destroy()
      return
    }
    if (wss.clients.size >= maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req, { routeKey, role, streamId })
    })
  })

  wss.on('connection', (ws, _req, identity) => {
    const { routeKey, role, streamId } = identity
    let route = routes.get(routeKey)

    if (role === 'gateway') {
      if (route?.gateway || routes.size >= maxRoutes && !route) return fail(ws, 'unavailable')
      if (!route) { route = { gateway: null, streams: new Map() }; routes.set(routeKey, route) }
      route.gateway = ws
      ws.on('message', (data, isBinary) => {
        if (data.length > MAX_FRAME_BYTES) return fail(ws, 'protocol')
        if (isBinary) {
          const parsed = parseEnvelope(data)
          const stream = parsed && route.streams.get(parsed.streamId)
          if (!parsed || !stream || stream.state !== 'active') return fail(ws, 'protocol')
          if (!sendBinary(stream.device, parsed.payload)) detachStream(route, parsed.streamId, false)
          return
        }
        const message = parseControl(data.toString())
        const stream = message && route.streams.get(message.streamId)
        if (!message || !stream) return fail(ws, 'protocol')
        if (message.type === 'accept') {
          if (stream.state !== 'pending') return fail(ws, 'protocol')
          stream.state = 'active'
          clearPending(stream)
          if (!sendText(stream.device, JSON.stringify({ type: 'ready', streamId: message.streamId }))) {
            detachStream(route, message.streamId, true)
          }
          return
        }
        clearPending(stream)
        route.streams.delete(message.streamId)
        if (message.type === 'reject') fail(stream.device, 'rejected')
        else if (stream.device.readyState === WebSocket.OPEN) stream.device.close(1000, 'stream closed')
      })
      ws.on('close', () => closeRoute(routeKey, route))
      ws.on('error', () => closeRoute(routeKey, route))
      return
    }

    if (!route?.gateway || route.streams.has(streamId)) return fail(ws, 'unavailable')
    if (route.streams.size >= maxStreamsPerRoute) return fail(ws, 'limit')
    const stream = { device: ws, state: 'pending', timer: undefined }
    route.streams.set(streamId, stream)
    stream.timer = setTimeout(() => {
      if (route.streams.get(streamId) !== stream) return
      detachStream(route, streamId, true, false)
      fail(ws, 'timeout')
    }, openTimeoutMs)
    stream.timer.unref?.()
    if (!sendText(route.gateway, JSON.stringify({ type: 'open', streamId }))) {
      detachStream(route, streamId, false)
      fail(ws, 'unavailable')
    }

    ws.on('message', (data, isBinary) => {
      if (!isBinary || data.length > MAX_FRAME_BYTES - ENVELOPE_BYTES) return fail(ws, 'protocol')
      if (stream.state !== 'active' || route.streams.get(streamId) !== stream) return fail(ws, 'protocol')
      if (!sendBinary(route.gateway, envelope(streamId, data))) detachStream(route, streamId, false)
    })
    ws.on('close', () => detachStream(route, streamId, true))
    ws.on('error', () => detachStream(route, streamId, true))
  })

  return {
    server: httpServer,
    routes,
    listen(...args) { return new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(...args, () => { httpServer.off('error', reject); resolve(httpServer.address()) })
    }) },
    close() { return new Promise(resolve => {
      for (const [key, route] of routes) closeRoute(key, route)
      for (const client of wss.clients) client.terminate()
      wss.close(() => httpServer.close(() => resolve()))
    }) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080)
  const relay = createRelayServer(relayCapacityFromEnv())
  relay.listen(port, process.env.HOST || '0.0.0.0').then(address => {
    process.stdout.write(`mobile relay listening on ${address.address}:${address.port}\n`)
  }).catch(() => { process.stderr.write('mobile relay failed to listen\n'); process.exitCode = 1 })
}
