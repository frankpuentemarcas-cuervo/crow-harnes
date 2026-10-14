import { connect as connectTcp, type Socket } from 'node:net'
import WebSocket, { type ClientOptions } from 'ws'

const ENVELOPE_MAGIC = Buffer.from('CHT1', 'ascii')
const ENVELOPE_HEADER_BYTES = 40
const MAX_FRAME_BYTES = 64 * 1024
const MAX_QUEUED_BYTES = 1024 * 1024
const MAX_ACTIVE_STREAMS = 8
const STREAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RelayControl = { type: 'open'; streamId: string } | { type: 'accept' | 'reject' | 'close'; streamId: string }

export interface MobileRelayClientOptions {
  url: string
  routeId: string
  localPort: number
  localHost?: string
  reconnectMinMs?: number
  reconnectMaxMs?: number
  heartbeatIntervalMs?: number
  /** Allows deterministic TLS/WebSocket setup in tests; normal callers should omit it. */
  webSocketFactory?: (url: string, options: ClientOptions) => WebSocket
  /** Injected timer randomness for deterministic tests. */
  random?: () => number
}

export interface MobileRelayStatus {
  state: 'stopped' | 'connecting' | 'connected' | 'reconnecting'
  activeStreams: number
  reconnectAttempts: number
}

interface ActiveStream {
  socket: Socket
  queuedBytes: number
  ready: boolean
}

function validRouteId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

function isStreamId(value: unknown): value is string {
  return typeof value === 'string' && STREAM_ID_PATTERN.test(value)
}

function parseControl(data: Buffer): RelayControl | null {
  if (data.length > MAX_FRAME_BYTES) return null
  try {
    const value = JSON.parse(data.toString('utf8')) as Record<string, unknown>
    if (!isStreamId(value.streamId)) return null
    if (value.type === 'open') return { type: 'open', streamId: value.streamId }
    if (value.type === 'accept' || value.type === 'reject' || value.type === 'close') return { type: value.type, streamId: value.streamId }
    return null
  } catch {
    return null
  }
}

/**
 * Windows-side TCP↔WebSocket relay client. The relay can select only a stream ID;
 * every TCP connection is made to the caller-configured fixed local endpoint.
 */
export class MobileRelayClient {
  private readonly url: URL
  private readonly routeId: string
  private readonly localHost: string
  private readonly localPort: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly heartbeatIntervalMs: number
  private readonly makeWebSocket: (url: string, options: ClientOptions) => WebSocket
  private readonly random: () => number
  private readonly streams = new Map<string, ActiveStream>()
  private socket?: WebSocket
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private reconnectAttempts = 0
  private connectedAt = 0
  private lastPongAt = 0
  private stopping = true
  private state: MobileRelayStatus['state'] = 'stopped'

  constructor(options: MobileRelayClientOptions) {
    this.url = new URL(options.url)
    if (this.url.protocol !== 'wss:' || this.url.pathname !== '/v1/tunnel' || this.url.search || this.url.hash) {
      throw new Error('Relay URL must be wss://.../v1/tunnel')
    }
    if (!validRouteId(options.routeId)) throw new Error('Invalid relay route configuration')
    if (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535) {
      throw new Error('Invalid local relay target configuration')
    }
    this.routeId = options.routeId
    this.localHost = options.localHost ?? '127.0.0.1'
    this.localPort = options.localPort
    this.reconnectMinMs = Math.max(1, options.reconnectMinMs ?? 250)
    this.reconnectMaxMs = Math.max(this.reconnectMinMs, options.reconnectMaxMs ?? 10_000)
    this.heartbeatIntervalMs = Math.max(1, options.heartbeatIntervalMs ?? 15_000)
    this.makeWebSocket = options.webSocketFactory ?? ((url, opts) => new WebSocket(url, opts))
    this.random = options.random ?? Math.random
  }

  start(): void {
    if (!this.stopping) return
    this.stopping = false
    this.reconnectAttempts = 0
    this.openConnection()
  }

  stop(): void {
    this.stopping = true
    this.state = 'stopped'
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.reconnectTimer = undefined
    this.heartbeatTimer = undefined
    this.closeAllStreams()
    const ws = this.socket
    this.socket = undefined
    if (ws) {
      ws.removeAllListeners()
      if (ws.readyState === WebSocket.OPEN) ws.terminate()
      else if (ws.readyState === WebSocket.CONNECTING) ws.close()
    }
  }

  status(): MobileRelayStatus {
    return { state: this.state, activeStreams: this.streams.size, reconnectAttempts: this.reconnectAttempts }
  }

  private openConnection(): void {
    if (this.stopping) return
    this.state = this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting'
    let ws: WebSocket
    try {
      ws = this.makeWebSocket(this.url.toString(), {
        headers: { 'X-Crow-Route': this.routeId, 'X-Crow-Role': 'gateway' },
        perMessageDeflate: false,
        maxPayload: MAX_FRAME_BYTES
      })
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = ws
    ws.on('open', () => {
      if (this.socket !== ws || this.stopping) return
      this.state = 'connected'
      this.connectedAt = Date.now()
      this.lastPongAt = Date.now()
      this.heartbeatTimer = setInterval(() => this.heartbeat(ws), this.heartbeatIntervalMs)
    })
    ws.on('pong', () => { if (this.socket === ws) this.lastPongAt = Date.now() })
    ws.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
      if (this.socket !== ws || this.stopping) return
      const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
      if (frame.length > MAX_FRAME_BYTES) return this.protocolFailure(ws)
      if (!isBinary) return this.handleControl(ws, frame)
      this.handleData(ws, frame)
    })
    ws.on('close', () => this.connectionEnded(ws))
    ws.on('error', () => { /* Close handler performs cleanup; never expose transport details. */ })
  }

  private heartbeat(ws: WebSocket): void {
    if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.lastPongAt > this.heartbeatIntervalMs * 2) {
      ws.terminate()
      return
    }
    ws.ping()
  }

  private handleControl(ws: WebSocket, frame: Buffer): void {
    const control = parseControl(frame)
    if (!control) return this.protocolFailure(ws)
    if (control.type === 'close') {
      const stream = this.streams.get(control.streamId)
      if (!stream) return this.protocolFailure(ws)
      return this.closeStream(control.streamId, stream, false)
    }
    if (control.type !== 'open') return this.protocolFailure(ws)
    if (this.streams.has(control.streamId)) return this.reject(ws, control.streamId)
    if (this.streams.size >= MAX_ACTIVE_STREAMS) return this.reject(ws, control.streamId)

    const stream: ActiveStream = { socket: connectTcp({ host: this.localHost, port: this.localPort }), queuedBytes: 0, ready: false }
    this.streams.set(control.streamId, stream)
    stream.socket.setNoDelay(true)
    stream.socket.on('connect', () => {
      if (this.streams.get(control.streamId) !== stream) return
      stream.ready = true
      this.sendControl(ws, { type: 'accept', streamId: control.streamId })
    })
    stream.socket.on('data', (chunk: Buffer) => this.sendLocalData(ws, control.streamId, stream, chunk))
    stream.socket.on('error', () => {
      if (!stream.ready) this.reject(ws, control.streamId)
      this.closeStream(control.streamId, stream)
    })
    stream.socket.on('close', () => this.closeStream(control.streamId, stream))
  }

  private sendLocalData(ws: WebSocket, streamId: string, stream: ActiveStream, chunk: Buffer): void {
    if (!stream.ready || this.socket !== ws || ws.readyState !== WebSocket.OPEN) return this.closeStream(streamId, stream)
    const dataLimit = MAX_FRAME_BYTES - ENVELOPE_HEADER_BYTES
    for (let offset = 0; offset < chunk.length; offset += dataLimit) {
      const payload = chunk.subarray(offset, Math.min(offset + dataLimit, chunk.length))
      const envelope = this.envelope(streamId, payload)
      if (stream.queuedBytes + envelope.length > MAX_QUEUED_BYTES || ws.bufferedAmount + envelope.length > MAX_QUEUED_BYTES) {
        return this.closeStream(streamId, stream)
      }
      stream.queuedBytes += envelope.length
      ws.send(envelope, { binary: true, compress: false }, error => {
        stream.queuedBytes = Math.max(0, stream.queuedBytes - envelope.length)
        if (error) this.closeStream(streamId, stream)
      })
    }
  }

  private handleData(ws: WebSocket, frame: Buffer): void {
    if (frame.length < ENVELOPE_HEADER_BYTES || !frame.subarray(0, 4).equals(ENVELOPE_MAGIC)) return this.protocolFailure(ws)
    const streamId = frame.subarray(4, ENVELOPE_HEADER_BYTES).toString('ascii')
    if (!isStreamId(streamId)) return this.protocolFailure(ws)
    const stream = this.streams.get(streamId)
    if (!stream || !stream.ready) return this.protocolFailure(ws)
    const data = frame.subarray(ENVELOPE_HEADER_BYTES)
    if (stream.queuedBytes + stream.socket.writableLength + data.length > MAX_QUEUED_BYTES) {
      return this.closeStream(streamId, stream)
    }
    if (data.length && !stream.socket.write(data)) {
      // writableLength is the authoritative queued-byte count after write().
      if (stream.socket.writableLength > MAX_QUEUED_BYTES) this.closeStream(streamId, stream)
    }
  }

  private envelope(streamId: string, payload: Buffer): Buffer {
    return Buffer.concat([ENVELOPE_MAGIC, Buffer.from(streamId, 'ascii'), payload])
  }

  private reject(ws: WebSocket, streamId: string): void {
    this.sendControl(ws, { type: 'reject', streamId })
  }

  private sendControl(ws: WebSocket, message: RelayControl): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(message), { compress: false }, () => {})
  }

  private protocolFailure(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'Invalid relay protocol')
    else ws.terminate()
  }

  private closeStream(streamId: string, stream: ActiveStream, notifyRelay = true): void {
    if (this.streams.get(streamId) !== stream) return
    this.streams.delete(streamId)
    const ws = this.socket
    if (notifyRelay && stream.ready && ws?.readyState === WebSocket.OPEN) this.sendControl(ws, { type: 'close', streamId })
    stream.socket.destroy()
  }

  private closeAllStreams(): void {
    for (const [id, stream] of this.streams) this.closeStream(id, stream)
  }

  private connectionEnded(ws: WebSocket): void {
    if (this.socket !== ws) return
    this.socket = undefined
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (this.connectedAt && Date.now() - this.connectedAt >= 30_000) this.reconnectAttempts = 0
    this.connectedAt = 0
    this.closeAllStreams()
    if (!this.stopping) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return
    this.reconnectAttempts += 1
    this.state = 'reconnecting'
    const base = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** Math.min(this.reconnectAttempts - 1, 16))
    const delay = Math.floor(base * (0.5 + Math.max(0, Math.min(1, this.random()))))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.openConnection()
    }, delay)
  }
}

export { MAX_ACTIVE_STREAMS, MAX_FRAME_BYTES, MAX_QUEUED_BYTES, ENVELOPE_HEADER_BYTES }
