import { app, safeStorage } from 'electron'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpsServer } from 'node:https'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import forge from 'node-forge'
import { WebSocket, WebSocketServer } from 'ws'
import type { Connection } from './connection'
import { isPrivateLanIPv4 } from './mobile-network'
import type { MobileStatus, SavedState, SessionInfo, TerminalFrame } from '../shared/types'

type Dependencies = { snapshot(): SavedState; connection(hostId: string): Connection }
type Certificate = { address: string; key: string; cert: string; fingerprint: string }

export function mobileAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((entries) => (entries || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateLanIPv4(entry.address))
    .map((entry) => entry.address)))]
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function certificate(address: string): Certificate {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('El cifrado local de Windows no está disponible.')
  const path = join(app.getPath('userData'), 'mobile-tls.enc')
  try {
    if (existsSync(path)) {
      const saved = JSON.parse(safeStorage.decryptString(readFileSync(path))) as Certificate
      if (saved.address === address && saved.key && saved.cert && saved.fingerprint) return saved
    }
  } catch { /* Replace an unreadable certificate with a fresh local identity. */ }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomBytes(16).toString('hex')
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  cert.setSubject([{ name: 'commonName', value: 'Crow Harness LAN' }])
  cert.setIssuer([{ name: 'commonName', value: 'Crow Harness LAN' }])
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: address }, { type: 7, ip: '127.0.0.1' }] }
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const result: Certificate = {
    address,
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
    fingerprint: createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex').match(/.{2}/g)!.join(':').toUpperCase()
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, safeStorage.encryptString(JSON.stringify(result)), { mode: 0o600 })
  return result
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readJSON(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4096) { tooLarge = true; return }
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (tooLarge) { reject(new Error('Solicitud demasiado grande.')); return }
      try {
        const parsed: unknown = JSON.parse(body)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON inválido.')
        resolve(parsed as Record<string, unknown>)
      } catch { reject(new Error('JSON inválido.')) }
    })
    req.on('error', reject)
  })
}

export class MobileGateway {
  private server?: HttpsServer
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  private clients = new Set<WebSocket>()
  private pairingCode = ''
  private cookieToken = ''
  private origin = ''
  private fingerprint = ''
  private failures = new Map<string, { count: number; until: number }>()

  constructor(private deps: Dependencies) {}

  status(): MobileStatus {
    return this.server ? { running: true, url: this.origin, pairingCode: this.pairingCode || undefined, fingerprint: this.fingerprint, paired: !this.pairingCode } : { running: false }
  }

  async start(address: string): Promise<MobileStatus> {
    if (!mobileAddresses().includes(address)) throw new Error('Elegí una dirección IPv4 privada de este equipo.')
    if (!app.isPackaged) throw new Error('La vista móvil estará disponible en el instalador; no se expone el servidor de desarrollo.')
    if (this.server) await this.stop()
    const identity = certificate(address)
    this.pairingCode = randomBytes(8).toString('hex').toUpperCase()
    this.cookieToken = randomBytes(32).toString('hex')
    this.fingerprint = identity.fingerprint
    this.failures.clear()
    const server = createServer({ key: identity.key, cert: identity.cert }, (req, res) => { void this.handle(req, res) })
    server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head) })
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    await new Promise<void>((resolveStart, rejectStart) => {
      server.once('error', rejectStart)
      server.listen(0, address, () => { server.off('error', rejectStart); resolveStart() })
    })
    this.server = server
    server.on('error', () => { void this.stop() })
    const info = server.address()
    if (!info || typeof info === 'string') throw new Error('No se pudo abrir el gateway móvil.')
    this.origin = `https://${address}:${info.port}`
    return this.status()
  }

  async stop(): Promise<MobileStatus> {
    for (const client of this.clients) client.terminate()
    this.clients.clear()
    const server = this.server
    this.server = undefined
    this.cookieToken = ''
    this.pairingCode = ''
    this.origin = ''
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
    return this.status()
  }

  private authenticated(req: IncomingMessage): boolean {
    const cookie = req.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith('crow_mobile='))?.slice('crow_mobile='.length)
    return !!cookie && !!this.cookieToken && equalSecret(cookie, this.cookieToken)
  }

  private sameOrigin(req: IncomingMessage): boolean { return req.headers.origin === this.origin }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${this.origin.replace('https:', 'wss:')}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`)
    try {
      const url = new URL(req.url || '/', this.origin)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/mobile.html' || url.pathname.startsWith('/assets/'))) {
        this.staticFile(url.pathname, res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        if (!this.sameOrigin(req)) { json(res, 403, { error: 'Origen inválido.' }); return }
        const ip = req.socket.remoteAddress || ''
        const record = this.failures.get(ip)
        if (record && record.until > Date.now() && record.count >= 5) { json(res, 429, { error: 'Demasiados intentos. Reiniciá el acceso móvil en Crow.' }); return }
        const body = await readJSON(req)
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
        if (!this.pairingCode || !equalSecret(code, this.pairingCode)) {
          this.failures.set(ip, { count: (record?.count || 0) + 1, until: Date.now() + 10 * 60_000 })
          json(res, 401, { error: 'Código incorrecto.' }); return
        }
        this.pairingCode = '' // One phone per activation; restart to pair another.
        res.setHeader('Set-Cookie', `crow_mobile=${this.cookieToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`)
        json(res, 200, { ok: true }); return
      }
      if (!this.authenticated(req)) { json(res, 401, { error: 'Emparejamiento requerido.' }); return }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const saved = this.deps.snapshot()
        json(res, 200, {
          hosts: saved.hosts.map((host) => ({ id: host.id, name: host.name, status: this.deps.connection(host.id).status() })),
          projects: saved.projects.map(({ id, hostId, name, root }) => ({ id, hostId, name, root }))
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const hostId = url.searchParams.get('hostId') || ''
        const connection = this.allowedHost(hostId)
        const roots = new Set(this.deps.snapshot().projects.filter((project) => project.hostId === hostId).map((project) => project.root))
        const items = await connection.api<SessionInfo[]>('GET', '/api/sessions')
        json(res, 200, items.filter((item) => roots.has(item.root)))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/wake') {
        if (!this.sameOrigin(req)) { json(res, 403, { error: 'Origen inválido.' }); return }
        const body = await readJSON(req)
        const hostId = typeof body.hostId === 'string' ? body.hostId : ''
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const connection = await this.allowedSession(hostId, sessionId)
        json(res, 200, await connection.api<SessionInfo>('POST', `/api/sessions/${sessionId}/wake`))
        return
      }
      json(res, 404, { error: 'Ruta no encontrada.' })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'Error de solicitud.' })
    }
  }

  private staticFile(pathname: string, res: ServerResponse): void {
    const root = resolve(__dirname, '../renderer')
    const name = pathname === '/' ? 'mobile.html' : pathname.slice(1)
    const path = resolve(root, name)
    if (path !== resolve(root, 'mobile.html') && !path.startsWith(resolve(root, 'assets') + sep)) { json(res, 404, { error: 'No encontrado.' }); return }
    try {
      const body = readFileSync(path)
      const type = path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(body)
    } catch { json(res, 404, { error: 'Vista móvil no disponible.' }) }
  }

  private allowedHost(id: string): Connection {
    if (!this.deps.snapshot().hosts.some((host) => host.id === id)) throw new Error('Host no configurado.')
    return this.deps.connection(id)
  }

  private async allowedSession(hostId: string, sessionId: string): Promise<Connection> {
    if (!/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Sesión inválida.')
    const connection = this.allowedHost(hostId)
    const roots = new Set(this.deps.snapshot().projects.filter((project) => project.hostId === hostId).map((project) => project.root))
    const sessions = await connection.api<SessionInfo[]>('GET', '/api/sessions')
    if (!sessions.some((item) => item.id === sessionId && roots.has(item.root))) throw new Error('Sesión no configurada.')
    return connection
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(req.url || '/', this.origin)
      if (url.pathname !== '/ws' || !this.authenticated(req) || !this.sameOrigin(req)) throw new Error('No autorizado.')
      const hostId = url.searchParams.get('hostId') || ''
      const sessionId = url.searchParams.get('sessionId') || ''
      const from = Number(url.searchParams.get('from') || 0)
      if (!Number.isSafeInteger(from) || from < 0) throw new Error('Secuencia inválida.')
      const connection = await this.allowedSession(hostId, sessionId)
      this.sockets.handleUpgrade(req, socket, head, (client) => {
        this.clients.add(client)
        const streamId = randomUUID()
        client.on('message', (raw) => {
          try {
            const value = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number }
            if (value.type === 'input' && typeof value.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) connection.send(streamId, { type: 'input', data: value.data })
            if (value.type === 'resize' && Number.isInteger(value.cols) && Number.isInteger(value.rows) && value.cols! >= 1 && value.cols! <= 500 && value.rows! >= 1 && value.rows! <= 500) connection.send(streamId, { type: 'resize', cols: value.cols, rows: value.rows })
          } catch { /* Ignore malformed mobile input. */ }
        })
        client.on('close', () => { connection.detach(streamId); this.clients.delete(client) })
        void connection.attach(streamId, sessionId, from, (frame: TerminalFrame) => {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(frame))
        }).then(() => {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'ready' }))
        }).catch(() => client.close())
      })
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  }
}
