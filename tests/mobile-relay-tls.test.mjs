import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import { connect as connectTcp } from 'node:net'
import { Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'
import tls from 'node:tls'
import { WebSocket, WebSocketServer } from 'ws'
import forge from 'node-forge'

function makeCertificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = Date.now().toString(16)
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 60 * 60_000)
  cert.setSubject([{ name: 'commonName', value: 'localhost' }])
  cert.setIssuer([{ name: 'commonName', value: 'localhost' }])
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const certPem = forge.pki.certificateToPem(cert)
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary')
  return {
    cert: certPem,
    key: forge.pki.privateKeyToPem(keys.privateKey),
    fingerprint: createHash('sha256').update(der).digest('hex').match(/.{2}/g).join(':').toUpperCase()
  }
}

// A message-preserving WebSocket byte stream. _write waits for ws.send's callback,
// so TLS sees backpressure instead of an unbounded fire-and-forget queue.
class WebSocketByteStream extends Duplex {
  constructor(ws) {
    super()
    this.ws = ws
    this.closedByPeer = false
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return this.destroy(new Error('relay accepted a non-binary frame'))
      if (!this.push(Buffer.from(data))) ws.pause()
    })
    ws.on('close', () => {
      this.closedByPeer = true
      this.push(null)
    })
    ws.on('error', error => this.destroy(error))
  }

  _read() { this.ws.resume() }

  _write(chunk, _encoding, callback) {
    if (this.ws.readyState !== WebSocket.OPEN) return callback(new Error('relay WebSocket is not open'))
    this.ws.send(chunk, { binary: true, compress: false }, callback)
  }

  _final(callback) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'TLS stream ended')
    callback()
  }

  _destroy(error, callback) {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate()
    callback(error)
  }
}

function verifyPeer(socket, expectedFingerprint, servername) {
  const peer = socket.getPeerCertificate()
  assert.ok(peer.raw, 'TLS peer certificate is present')
  const actualFingerprint = createHash('sha256').update(peer.raw).digest('hex').match(/.{2}/g).join(':').toUpperCase()
  assert.equal(actualFingerprint, expectedFingerprint, 'leaf certificate SHA-256 pin matches exactly')
  const identityError = tls.checkServerIdentity(servername, peer)
  if (identityError) throw identityError
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function onceEvent(emitter, name) {
  return new Promise((resolve, reject) => {
    emitter.once(name, resolve)
    emitter.once('error', reject)
  })
}

test('WebSocket-backed TLS stream propagates write backpressure and close', async () => {
  const ws = new EventEmitter()
  ws.readyState = WebSocket.OPEN
  ws.send = (_chunk, _options, callback) => { ws.completeSend = callback }
  ws.terminate = () => { ws.readyState = WebSocket.CLOSED; ws.emit('close') }
  const stream = new WebSocketByteStream(ws)
  let writeCompleted = false
  stream.write(Buffer.from([22, 3, 3]), () => { writeCompleted = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writeCompleted, false, 'Duplex write remains pending while WebSocket send is backpressured')
  ws.completeSend()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writeCompleted, true)
  stream.destroy()
  await onceEvent(stream, 'close')
  assert.equal(ws.readyState, WebSocket.CLOSED)
})

function readHttpResponse(socket) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    const onData = chunk => {
      bytes = Buffer.concat([bytes, chunk])
      const boundary = bytes.indexOf('\r\n\r\n')
      if (boundary < 0) return
      const head = bytes.subarray(0, boundary).toString('latin1')
      const length = Number(/(?:^|\r\n)content-length:\s*(\d+)/i.exec(head)?.[1] || 0)
      if (bytes.length < boundary + 4 + length) return
      socket.off('data', onData)
      socket.off('error', onError)
      resolve({ head, body: bytes.subarray(boundary + 4, boundary + 4 + length).toString() })
    }
    const onError = error => { socket.off('data', onData); reject(error) }
    socket.on('data', onData)
    socket.once('error', onError)
  })
}

test('inner TLS survives an opaque binary WebSocket relay, then carries HTTPS and WSS', async t => {
  const identity = makeCertificate()
  const observedRequest = {}
  const backendSockets = new Set()
  const upgradeRequests = []
  const httpsServer = createHttpsServer(identity, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      Object.assign(observedRequest, { method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() })
      const body = 'inner https response'
      res.writeHead(200, { 'content-length': Buffer.byteLength(body), connection: 'keep-alive' })
      res.end(body)
    })
  })
  httpsServer.on('connection', socket => { backendSockets.add(socket); socket.once('close', () => backendSockets.delete(socket)) })
  const backendWs = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  httpsServer.on('upgrade', (req, socket, head) => {
    upgradeRequests.push(req.url)
    backendWs.handleUpgrade(req, socket, head, ws => {
      backendWs.emit('connection', ws, req)
      ws.send('upgrade reached the HTTPS server')
    })
  })
  const backendPort = await listen(httpsServer)
  t.after(async () => {
    for (const socket of backendSockets) socket.destroy()
    await new Promise(resolve => backendWs.close(resolve))
    await new Promise(resolve => httpsServer.close(resolve))
  })

  const relayServer = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: false })
  await onceEvent(relayServer, 'listening')
  const relayPort = relayServer.address().port
  const relayObservations = []
  const relayClients = new Set()
  let tamperNextClientMessage = false
  let splitBytes = 0
  let coalescedChunks = 0
  const relayBridges = new Set()
  relayServer.on('connection', (outerWs, req) => {
    relayClients.add(outerWs)
    outerWs.once('close', () => relayClients.delete(outerWs))
    const upstream = connectTcp(backendPort, '127.0.0.1')
    relayBridges.add(upstream)
    upstream.once('close', () => relayBridges.delete(upstream))
    let pendingServerData = []
    let flushScheduled = false
    outerWs.on('message', (data, isBinary) => {
      const payload = Buffer.from(data)
      relayObservations.push({ binary: isBinary, bytes: payload })
      let forwarded = payload
      if (tamperNextClientMessage) {
        tamperNextClientMessage = false
        forwarded = Buffer.from(payload)
        if (forwarded.length) forwarded[forwarded.length - 1] ^= 0x01
      }
      // TCP writes deliberately split each outer binary frame. TLS must tolerate
      // arbitrary relay/TCP chunk boundaries, independent of TLS record bounds.
      for (let offset = 0; offset < forwarded.length; offset += 11) {
        const fragment = forwarded.subarray(offset, offset + 11)
        if (fragment.length < forwarded.length) splitBytes++
        if (!upstream.write(fragment)) outerWs.pause()
      }
      upstream.once('drain', () => outerWs.resume())
    })
    upstream.on('data', data => {
      // Segment and re-coalesce the opaque stream before emitting relay frames.
      // The adversarial transport boundary is independent of TLS record bounds.
      pendingServerData.push(Buffer.from(data))
      if (flushScheduled) return
      flushScheduled = true
      setImmediate(() => {
        flushScheduled = false
        if (!pendingServerData.length || outerWs.readyState !== WebSocket.OPEN) return
        const source = Buffer.concat(pendingServerData)
        pendingServerData = []
        const pieces = []
        for (let offset = 0; offset < source.length; offset += 17) pieces.push(source.subarray(offset, offset + 17))
        // Recombine three adjacent fragments as one WebSocket binary frame.
        for (let index = 0; index < pieces.length; index += 3) {
          const group = pieces.slice(index, index + 3)
          if (group.length > 1) coalescedChunks += group.length - 1
          outerWs.send(Buffer.concat(group), { binary: true, compress: false })
        }
      })
    })
    upstream.on('error', () => outerWs.close(1011, 'upstream failed'))
    outerWs.once('close', () => upstream.destroy())
    outerWs.once('error', () => upstream.destroy())
    assert.equal(req.url, '/opaque', 'relay only receives its opaque rendezvous route')
  })
  t.after(async () => {
    for (const client of relayClients) client.terminate()
    for (const socket of relayBridges) socket.destroy()
    await new Promise(resolve => relayServer.close(resolve))
  })

  const openTls = async (servername = 'localhost', pin = identity.fingerprint) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/opaque`, { perMessageDeflate: false, headers: { 'x-relay-session': 'opaque-id' } })
    await onceEvent(ws, 'open')
    const stream = new WebSocketByteStream(ws)
    const socket = tls.connect({ socket: stream, servername, rejectUnauthorized: false, minVersion: 'TLSv1.2' })
    await onceEvent(socket, 'secureConnect')
    try { verifyPeer(socket, pin, servername) }
    catch (error) { socket.destroy(); throw error }
    return { socket, ws, stream }
  }

  const { socket, ws } = await openTls()
  t.after(() => socket.destroy())
  const token = 'Bearer never-visible-to-relay-9b2e'
  const body = 'request-body-never-visible-44a1'
  const responsePromise = readHttpResponse(socket)
  socket.write(`POST /private/mobile?bearer=never-visible-171c HTTP/1.1\r\nHost: localhost:${backendPort}\r\nAuthorization: ${token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`)
  const response = await responsePromise
  assert.match(response.head, /^HTTP\/1\.1 200/)
  assert.equal(response.body, 'inner https response')
  assert.deepEqual(observedRequest, { method: 'POST', url: '/private/mobile?bearer=never-visible-171c', authorization: token, body })

  const websocketKey = 'dGhlIHNhbXBsZSBub25jZQ=='
  const upgradeResponse = new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    const onData = chunk => {
      bytes = Buffer.concat([bytes, chunk])
      const boundary = bytes.indexOf('\r\n\r\n')
      if (boundary < 0) return
      const head = bytes.subarray(0, boundary).toString('latin1')
      const frame = bytes.subarray(boundary + 4)
      if (frame.length < 2) return
      const frameLength = frame[1] & 0x7f
      const frameHeaderLength = frameLength < 126 ? 2 : frameLength === 126 ? 4 : 10
      const payloadLength = frameLength < 126 ? frameLength : frameLength === 126 ? frame.readUInt16BE(2) : Number(frame.readBigUInt64BE(2))
      if (frame.length < frameHeaderLength + payloadLength) return
      socket.off('data', onData)
      socket.off('error', onError)
      resolve({ head, opcode: frame[0] & 0x0f, payload: frame.subarray(frameHeaderLength, frameHeaderLength + payloadLength).toString() })
    }
    const onError = error => { socket.off('data', onData); reject(error) }
    socket.on('data', onData)
    socket.once('error', onError)
  })
  socket.write(`GET /private/upgrade?bearer=ws-secret-f0a7 HTTP/1.1\r\nHost: localhost:${backendPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${websocketKey}\r\n\r\n`)
  const upgraded = await upgradeResponse
  assert.match(upgraded.head, /^HTTP\/1\.1 101/)
  const expectedAccept = createHash('sha1').update(websocketKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  assert.ok(upgraded.head.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`))
  assert.equal(upgraded.opcode, 1)
  assert.equal(upgraded.payload, 'upgrade reached the HTTPS server')
  assert.deepEqual(upgradeRequests, ['/private/upgrade?bearer=ws-secret-f0a7'])

  const outerBytes = Buffer.concat(relayObservations.map(item => item.bytes))
  assert.ok(relayObservations.length > 0)
  assert.ok(relayObservations.every(item => item.binary), 'relay receives only binary WebSocket messages')
  for (const secret of [token, body, '/private/mobile', 'ws-secret-f0a7', 'upgrade reached the HTTPS server']) {
    assert.equal(outerBytes.includes(Buffer.from(secret)), false, `relay bytes do not expose ${secret}`)
  }
  assert.ok(splitBytes > 0, 'relay fragmented TLS bytes across TCP writes')
  assert.ok(coalescedChunks > 0, 'relay coalesced server TLS chunks into binary frames')
  assert.ok(relayObservations.some(item => item.bytes[0] === 22 || item.bytes[0] === 23), 'relay observed TLS record bytes, not HTTP text')

  const tampered = await openTls()
  tamperNextClientMessage = true
  const failure = new Promise(resolve => {
    tampered.socket.once('error', resolve)
    tampered.socket.once('close', () => resolve(new Error('TLS closed after tampering')))
  })
  tampered.socket.write('GET /integrity HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
  let integrityTimer
  const timeout = new Promise((_, reject) => { integrityTimer = setTimeout(() => reject(new Error('tampered TLS record was not rejected')), 5_000) })
  integrityTimer.unref()
  let integrityError
  try { integrityError = await Promise.race([failure, timeout]) }
  finally { clearTimeout(integrityTimer) }
  assert.match(integrityError.message, /decrypt|bad record|alert|TLS closed/i)
  tampered.socket.destroy()

  const wrongPin = await openTls('localhost', '00:'.repeat(31) + '00')
    .then(() => undefined, error => error)
  assert.ok(wrongPin instanceof Error, 'mismatched certificate fingerprint is rejected')
  const wrongName = await openTls('wrong.example')
    .then(() => undefined, error => error)
  assert.ok(wrongName instanceof Error, 'mismatched certificate name is rejected')

  const closeProbe = await openTls()
  const closed = onceEvent(closeProbe.ws, 'close')
  closeProbe.socket.destroy()
  await closed
})
