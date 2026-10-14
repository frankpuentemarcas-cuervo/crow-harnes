import { app, safeStorage } from 'electron'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import forge from 'node-forge'
import { WebSocket, WebSocketServer } from 'ws'
import type { Connection } from './connection'
import { isPrivateLanIPv4 } from './mobile-network'
import type { MobileStatus, SavedState, SessionInfo, TerminalFrame } from '../shared/types'
import { MOBILE_SUPPORTED_FEATURES, type MobileActorBinding, type MobileCapabilities, type MobileDevice, type MobileEndpoint, type MobileEnrollment, type MobileEnrollmentInput, type MobileErrorCode, type MobileErrorEnvelope, type MobileNotice, type MobileQuota, type MobileSession, type MobileStartInput } from '../shared/mobile-companion'
import { MobileDeviceRegistry, MobileHostUnavailableError, MobileAuthorizationChangedError, READ_CAPABILITIES, type DeviceRecord, type MobileScope } from './mobile-device-auth'
import { MobileTrustStore, type MobileTrustPersistence, type MobileTrustSnapshot } from './mobile-trust-store'
import { MobileMutationLedger, MobileMutationRejectedError, type MobileMutationContext, type MobileMutationResult, type MobileMutationRoute } from './mobile-mutation-ledger'
import type { MobileRelayClient, MobileRelayClientOptions, MobileRelayStatus } from './mobile-relay-client'

export type MobileGatewayDependencies = {
  snapshot(): SavedState
  configurationSnapshot?(): SavedState
  connection(hostId: string): Connection
  authSnapshot?(hostId: string): Promise<MobileActorBinding>
  quotas?(): MobileQuota[]
  notices?(): MobileNotice[]
  actorLabel?(): string
  trustStore?: MobileTrustPersistence
  relayClientFactory?: (options: MobileRelayClientOptions) => Pick<MobileRelayClient, 'start' | 'stop' | 'status'>
}
interface StreamRecord { client: WebSocket; connection: Connection; streamId: string; hostId: string; sessionId: string; device?: DeviceRecord; browser: boolean; credentialExpiresAt?: number; mutationContext?: MobileMutationContext }
type Certificate = { address: string; key: string; cert: string; fingerprint: string }

/** Provider selection is explicit; forwarded headers never choose the trusted origin. */
export function mobileRemoteConfig(input: string | MobileStartInput): { provider: 'tailscale' | 'pangolin'; origin: string; port: number } | undefined {
  if (typeof input === 'string') return
  const provider = input.remoteProvider === undefined ? 'tailscale' : input.remoteProvider
  if (provider !== 'tailscale' && provider !== 'pangolin') throw new Error('Proveedor remoto inválido.')
  if (!input.publicOrigin) {
    if (provider === 'pangolin' || input.loopbackPort !== undefined) throw new Error('Pangolin requiere un dominio HTTPS y un puerto backend fijo.')
    return
  }
  const message = provider === 'tailscale' ? 'Configurá una URL HTTPS explícita de Tailscale Serve (*.ts.net).' : 'Configurá un dominio HTTPS público exacto, sin puerto, ruta, usuario ni parámetros.'
  const match = /^https:\/\/([a-z0-9.-]+)\/?$/i.exec(input.publicOrigin)
  const hostname = match?.[1].toLowerCase() || ''
  if (!hostname || hostname.length > 253 || !hostname.includes('.') || hostname.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) || !/\.[a-z]{2,63}$/.test(hostname) || /\.(localhost|local|internal)$/.test(hostname)) throw new Error(message)
  const url = new URL(input.publicOrigin)
  if (url.protocol !== 'https:' || url.hostname !== hostname || url.port || (provider === 'tailscale' && !hostname.endsWith('.ts.net'))) throw new Error(message)
  if (provider === 'pangolin') {
    if (!Number.isInteger(input.loopbackPort) || Number(input.loopbackPort) < 1024 || Number(input.loopbackPort) > 65535) throw new Error('Elegí un puerto backend fijo entre 1024 y 65535 para Newt.')
  } else if (input.loopbackPort !== undefined) throw new Error('El puerto fijo requiere seleccionar Pangolin.')
  return { provider, origin: url.origin, port: input.loopbackPort || 0 }
}

export function mobileRelayConfig(input: string | MobileStartInput): string | undefined {
  if (typeof input === 'string' || input.relayUrl === undefined || input.relayUrl.trim() === '') return
  try {
    const url = new URL(input.relayUrl)
    if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.pathname !== '/v1/tunnel' || url.search || url.hash || url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error()
    return url.toString()
  } catch { throw new Error('Configurá una URL WSS exacta del relay que termine en /v1/tunnel.') }
}

export function listenMobileLoopback(server: HttpServer, port: number): Promise<void> {
  return new Promise((ok, fail) => {
    const error = (reason: NodeJS.ErrnoException): void => { server.off('error', error); fail(reason.code === 'EADDRINUSE' ? new Error(`El puerto backend ${port} está ocupado. Elegí otro y actualizá Newt; no se cambia automáticamente.`) : new Error('No se pudo abrir el backend solo loopback.')) }
    server.once('error', error)
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => { server.off('error', error); ok() })
  })
}

function listenMobileTlsLoopback(server: HttpsServer, port: number): Promise<void> {
  return new Promise((ok, fail) => {
    const error = (reason: NodeJS.ErrnoException): void => { server.off('error', error); fail(reason.code === 'EADDRINUSE' ? new Error(`El puerto local TLS ${port} está ocupado. Cerrá la aplicación que lo usa y reintentá.`) : new Error('No se pudo abrir el túnel TLS local.')) }
    server.once('error', error)
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => { server.off('error', error); ok() })
  })
}

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

function mobileError(code: MobileErrorCode, error: string): MobileErrorEnvelope { return { code, error } }
function isNativeApiRequest(req: IncomingMessage): boolean { return /^\/api\/v[12]\//.test(req.url || '') }

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
  private loopback?: HttpServer
  private relayTlsServer?: HttpsServer
  private relayClient?: Pick<MobileRelayClient, 'start' | 'stop' | 'status'>
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
  private clients = new Map<string, StreamRecord>()
  private registry = new MobileDeviceRegistry()
  private gatewayId: string = randomUUID()
  private lanAddress = ''
  private lanPort = 0
  private pairingCode = ''
  private pairingExpires = 0
  private cookieToken = ''
  private cookieExpires = 0
  private browserScopes: MobileScope[] = []
  private browserSnapshot = ''
  private origin = ''
  private fingerprint = ''
  private endpoints: MobileEndpoint[] = []
  private loopbackUrl = ''
  private remoteProvider?: 'tailscale' | 'pangolin'
  private relayUrl = ''
  private relayRoute = ''
  private relayLocalPort = 0
  private failures = new Map<string, { count: number; until: number }>()
  private monitor?: NodeJS.Timeout
  private trustStore?: MobileTrustPersistence
  private trustLoaded = false
  private trustFault?: Error
  private hostEpochs: Record<string, number> = {}
  private mutations = new MobileMutationLedger()

  constructor(private deps: MobileGatewayDependencies) {}

  private trustSnapshot(records: DeviceRecord[]): MobileTrustSnapshot {
    return { version: 2, gatewayId: this.gatewayId, lanAddress: this.lanAddress, lanPort: this.lanPort, hostEpochs: this.hostEpochs, records, relayRoute: this.relayRoute, relayLocalPort: this.relayLocalPort, ...(this.relayUrl ? { relayUrl: this.relayUrl } : {}) }
  }
  private saveTrust(records = this.registry.snapshot()): void {
    try { this.trustStore!.save(this.trustSnapshot(records)) }
    catch { this.trustFault = new MobileHostUnavailableError('No se pudo guardar el almacén móvil. El acceso está bloqueado; repará el almacenamiento seguro antes de continuar.'); throw this.trustFault }
  }
  private ensureTrust(): void {
    if (this.trustFault) throw this.trustFault
    if (this.trustLoaded) return
    try {
      this.trustStore = this.deps.trustStore || new MobileTrustStore(join(app.getPath('userData'), 'mobile-trust.enc'), safeStorage)
      const saved = this.trustStore.load()
      if (saved) {
        this.gatewayId = saved.gatewayId; this.lanAddress = saved.lanAddress; this.lanPort = saved.lanPort; this.hostEpochs = structuredClone(saved.hostEpochs)
      }
      this.relayRoute = saved?.relayRoute || randomBytes(32).toString('base64url')
      this.relayLocalPort = saved?.relayLocalPort || 0
      this.relayUrl = saved?.relayUrl || ''
      this.registry = new MobileDeviceRegistry(Date.now, saved?.records, records => this.saveTrust(records))
      if (!saved || !saved.relayRoute) this.saveTrust()
      this.trustLoaded = true
    } catch (error) { this.trustFault = new MobileHostUnavailableError(error instanceof Error ? error.message : 'Almacén móvil no disponible.'); throw this.trustFault }
  }
  hostAuthorizationEpoch(hostId: string): number { this.ensureTrust(); return this.hostEpochs[hostId] || 0 }

  status(): MobileStatus {
    this.ensureTrust()
    return this.server ? { running: true, url: this.origin, pairingCode: this.pairingCode && Date.now() < this.pairingExpires ? this.pairingCode : undefined, fingerprint: this.fingerprint, paired: this.registry.list().length > 0 || (!!this.cookieToken && !this.pairingCode), enrollment: this.registry.invitation(), devices: this.devices(), loopbackUrl: this.loopbackUrl || undefined, remoteProvider: this.remoteProvider, relayUrl: this.relayUrl || undefined, relayState: this.relayClient?.status().state } : { running: false, devices: this.devices(), paired: this.registry.list().length > 0, relayUrl: this.relayUrl || undefined }
  }
  devices(): MobileDevice[] { this.ensureTrust(); return this.registry.list() }
  revoke(id: string): void {
    this.ensureTrust()
    try { this.registry.revoke(id) }
    finally { for (const stream of this.clients.values()) if (stream.device?.device.id === id) stream.client.terminate() }
  }
  invalidateHost(hostId: string): void {
    this.ensureTrust()
    this.hostEpochs = { ...this.hostEpochs, [hostId]: this.hostAuthorizationEpoch(hostId) + 1 }
    try { this.registry.invalidateHost(hostId).forEach(id => this.revoke(id)) }
    finally {
      this.cookieToken = ''; this.browserScopes = []; this.pairingCode = ''
      for (const stream of this.clients.values()) if (stream.hostId === hostId || stream.browser) stream.client.terminate()
    }
  }
  suspendHost(hostId: string): void {
    this.registry.cancelInvitation(hostId)
    this.registry.cancelAccess(hostId)
    this.cookieToken = ''; this.browserScopes = []; this.pairingCode = ''
    for (const stream of this.clients.values()) if (stream.hostId === hostId || stream.browser) stream.client.terminate()
  }
  async invite(input: MobileEnrollmentInput, version: 1 | 2 = 2): Promise<MobileEnrollment> {
    this.ensureTrust()
    if (!this.server) throw new Error('Activá primero el gateway móvil.')
    if (!Array.isArray(input.projectIds) || input.projectIds.length < 1 || input.projectIds.length > 64 || input.projectIds.some(id => typeof id !== 'string')) throw new Error('Proyectos inválidos.')
    const capabilities = { ...READ_CAPABILITIES }
    for (const key of Object.keys(capabilities) as (keyof MobileCapabilities)[]) {
      const value = input.capabilities?.[key]
      if (value !== undefined && typeof value !== 'boolean') throw new Error('Permiso inválido.')
      capabilities[key] = value === true
    }
    const scopes: MobileScope[] = []
    for (const projectId of new Set(input.projectIds)) {
      const saved = this.deps.snapshot()
      const project = saved.projects.find(project => project.id === projectId)
      if (!project) throw new Error('Proyecto no autorizado.')
      const binding = await this.actor(project.hostId)
      if (!binding.allowedRoots.includes(project.root)) throw new Error('Proyecto no autorizado para esta identidad.')
      scopes.push({ projectId, hostId: project.hostId, root: project.root, hostDigest: this.hostDigest(project.hostId), binding })
    }
    await this.validateScopes(scopes)
    return this.registry.invite({ version, gatewayId: this.gatewayId, endpoints: this.endpoints }, scopes, capabilities)
  }

  async start(input: string | MobileStartInput): Promise<MobileStatus> {
    this.ensureTrust()
    const address = typeof input === 'string' ? input : input.address
    const remote = mobileRemoteConfig(input)
    const relay = typeof input === 'string' || input.relayUrl === undefined ? (this.relayUrl || undefined) : mobileRelayConfig(input)
    if (!mobileAddresses().includes(address)) throw new Error('Elegí una dirección IPv4 privada de este equipo.')
    if (!app.isPackaged) throw new Error('La vista móvil estará disponible en el instalador; no se expone el servidor de desarrollo.')
    if (this.server) await this.stop()
    const tls = certificate(address)
    this.pairingCode = randomBytes(8).toString('hex').toUpperCase()
    this.pairingExpires = Date.now() + 5 * 60_000
    this.cookieToken = randomBytes(32).toString('hex')
    this.cookieExpires = Date.now() + 12 * 60 * 60_000
    this.fingerprint = tls.fingerprint
    this.failures.clear()
    this.browserSnapshot = this.snapshotDigest()
    const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => { void this.handle(req, res, false) })
    server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head, false) })
    server.headersTimeout = 10_000; server.requestTimeout = 30_000
    // Reuse the last LAN endpoint on resume. A conflict is an error, never a silent endpoint change.
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(this.lanAddress === address ? this.lanPort : 0, address, () => { server.off('error', fail); ok() }) })
    this.server = server
    server.on('error', () => { void this.stop() })
    const info = server.address()
    if (!info || typeof info === 'string') { await this.stop(); throw new Error('No se pudo abrir el gateway móvil.') }
    this.lanAddress = address; this.lanPort = info.port
    this.origin = `https://${address}:${info.port}`
    this.endpoints = [{ kind: 'lan-pinned', url: this.origin, certSHA256: tls.fingerprint }]
    try {
      this.remoteProvider = remote?.provider
      if (remote) {
        this.endpoints.push({ kind: 'remote-public', url: remote.origin, ...(remote.provider === 'pangolin' ? { provider: 'pangolin', proxyAuthRequired: true } as const : {}) })
        const loopback = createHttpServer((req, res) => { void this.handle(req, res, true) })
        loopback.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head, true) })
        loopback.headersTimeout = 10_000; loopback.requestTimeout = 30_000
        await listenMobileLoopback(loopback, remote.port)
        this.loopback = loopback
        loopback.on('error', () => { void this.stop() })
        const info = loopback.address()
        if (!info || typeof info === 'string') throw new Error('No se pudo abrir el proxy local.')
        this.loopbackUrl = `http://127.0.0.1:${info.port}` // Desktop-only Serve target; never an enrollment endpoint.
      }
      this.relayUrl = relay || ''
      if (relay) {
        if (!this.deps.relayClientFactory) throw new Error('El cliente de relay no está disponible en esta versión de Crow.')
        const relayTls = createServer({ key: tls.key, cert: tls.cert }, (req, res) => { void this.handle(req, res, false) })
        relayTls.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head, false) })
        relayTls.headersTimeout = 10_000; relayTls.requestTimeout = 30_000
        await listenMobileTlsLoopback(relayTls, this.relayLocalPort)
        this.relayTlsServer = relayTls
        relayTls.on('error', () => { void this.stop() })
        const relayAddress = relayTls.address()
        if (!relayAddress || typeof relayAddress === 'string') throw new Error('No se pudo iniciar el endpoint TLS local del relay.')
        this.relayLocalPort = relayAddress.port
        const localOrigin = `https://127.0.0.1:${relayAddress.port}`
        this.endpoints.push({ kind: 'relay', url: localOrigin, certSHA256: tls.fingerprint, relayUrl: relay, relayRoute: this.relayRoute })
        this.relayClient = this.deps.relayClientFactory({ url: relay, routeId: this.relayRoute, localPort: relayAddress.port })
        this.relayClient.start()
      } else this.relayUrl = ''
      this.saveTrust()
      this.monitor = setInterval(() => { void this.auditStreams() }, 2_000)
      this.monitor.unref()
      return this.status()
    } catch (error) { await this.stop(); throw error }
  }

  async stop(): Promise<MobileStatus> {
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = undefined
    for (const stream of this.clients.values()) { stream.connection.detach(stream.streamId); stream.client.terminate() }
    this.clients.clear()
    this.relayClient?.stop(); this.relayClient = undefined
    const servers = [this.server, this.loopback, this.relayTlsServer]
    this.server = undefined; this.loopback = undefined; this.relayTlsServer = undefined
    this.remoteProvider = undefined
    this.cookieToken = ''; this.pairingCode = ''; this.origin = ''; this.loopbackUrl = ''; this.endpoints = []; this.browserScopes = []
    this.registry.cancelInvitation(); this.failures.clear()
    this.registry.cancelAccess()
    this.mutations.clear() // All bearer contexts have already been retired.
    await Promise.all(servers.map(server => server && new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections() })))
    return this.status()
  }

  private hostDigest(hostId: string): string {
    const host = (this.deps.configurationSnapshot?.() || this.deps.snapshot()).hosts.find(host => host.id === hostId)
    if (!host) throw new MobileAuthorizationChangedError('Host no configurado.')
    return createHash('sha256').update(JSON.stringify([host.id, host.target, host.port, host.remotePort, host.identity || ''])).digest('hex')
  }
  private snapshotDigest(): string {
    const saved = this.deps.snapshot()
    return createHash('sha256').update(JSON.stringify([saved.hosts.map(host => [host.id, host.target, host.port, host.remotePort, host.identity || '']).sort(), saved.projects.map(project => [project.id, project.hostId, project.root]).sort()])).digest('hex')
  }
  private async actor(hostId: string): Promise<MobileActorBinding> {
    if (!this.deps.authSnapshot) throw new MobileAuthorizationChangedError('Se requiere una credencial individual activa en el host.')
    if (this.deps.connection(hostId).status() !== 'connected') throw new MobileHostUnavailableError('Host desconectado. El acceso está pausado.')
    let value: MobileActorBinding
    try { value = await this.deps.authSnapshot(hostId) }
    catch (error) {
      if (error instanceof MobileAuthorizationChangedError) throw error
      throw new MobileHostUnavailableError('No se pudo comprobar la identidad. El acceso está pausado.')
    }
    if (this.deps.connection(hostId).status() !== 'connected') throw new MobileHostUnavailableError('Host desconectado. El acceso está pausado.')
    if (!value?.actorId || !value.generation || !Array.isArray(value.allowedRoots) || value.allowedRoots.some(root => typeof root !== 'string') || typeof value.operateOthers !== 'boolean') throw new MobileAuthorizationChangedError('Identidad no disponible.')
    return value
  }
  private sameBinding(a: MobileActorBinding, b: MobileActorBinding): boolean {
    return a.actorId === b.actorId && a.generation === b.generation && a.operateOthers === b.operateOthers && (a.role === undefined || a.role === b.role) && JSON.stringify([...a.allowedRoots].sort()) === JSON.stringify([...b.allowedRoots].sort())
  }
  private async validateScopes(scopes: MobileScope[]): Promise<void> {
    for (const scope of scopes) {
      this.validateConfig(scope)
      const live = await this.actor(scope.hostId)
      this.validateConfig(scope)
      if (!this.sameBinding(live, scope.binding) || !live.allowedRoots.includes(scope.root)) throw new MobileAuthorizationChangedError('La identidad o autorización cambió. Volvé a emparejar.')
    }
  }
  private validateConfig(scope: MobileScope): void {
    const project = (this.deps.configurationSnapshot?.() || this.deps.snapshot()).projects.find(project => project.id === scope.projectId)
    if (!project || project.hostId !== scope.hostId || project.root !== scope.root || this.hostDigest(scope.hostId) !== scope.hostDigest) throw new MobileAuthorizationChangedError('La configuración autorizada cambió.')
  }
  private async validateDevice(record: DeviceRecord): Promise<void> {
    this.ensureTrust()
    if (!this.registry.active(record)) throw new Error('Emparejamiento vencido o revocado.')
    if (!this.server) throw new MobileHostUnavailableError('Gateway pausado.')
    try { await this.validateScopes(record.scopes) } catch (error) {
      if (error instanceof MobileAuthorizationChangedError) this.revoke(record.device.id)
      throw error
    }
    if (!this.registry.active(record)) throw new Error('Emparejamiento revocado.')
    if (!this.server) throw new MobileHostUnavailableError('Gateway pausado.')
  }
  private nativeOrigin(req: IncomingMessage): boolean { return !req.headers.origin || this.endpoints.some(endpoint => endpoint.url === req.headers.origin) }
  private async nativeAuth(req: IncomingMessage): Promise<DeviceRecord> {
    if (!this.nativeOrigin(req)) throw new Error('Origen inválido.')
    const match = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')
    const record = match && this.registry.authenticate(match[1])
    if (!record) throw new Error('Emparejamiento requerido.')
    await this.validateDevice(record)
    return record
  }
  private browserAuth(req: IncomingMessage): boolean {
    const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('crow_mobile='))?.slice('crow_mobile='.length)
    return !!cookie && !!this.cookieToken && !this.pairingCode && Date.now() < this.cookieExpires && equalSecret(cookie, this.cookieToken) && this.browserSnapshot === this.snapshotDigest()
  }
  private async browserValid(): Promise<void> {
    if (!this.cookieToken || Date.now() >= this.cookieExpires || this.browserSnapshot !== this.snapshotDigest()) throw new Error('Emparejamiento requerido.')
    if (this.browserScopes.length) await this.validateScopes(this.browserScopes)
  }
  private string(body: Record<string, unknown>, key: string, max = 128): string {
    if (typeof body[key] !== 'string' || !(body[key] as string).length || (body[key] as string).length > max) throw new Error('Solicitud inválida.')
    return body[key] as string
  }
  private safeSession(info: SessionInfo, scopes: MobileScope[], input: boolean): MobileSession {
    const scope = scopes.find(scope => scope.root === info.root)
    if (!scope) throw new Error('Sesión fuera del proyecto autorizado.')
    return { id: info.id, agent: info.agent, mode: info.mode, state: info.state, agentState: info.agentState, startedAt: info.startedAt, updatedAt: info.updatedAt, seq: info.seq, exitCode: info.exitCode, readOnly: info.readOnly, projectId: scope.projectId, name: this.deps.snapshot().sessionNames[info.id], canOperate: input && this.canOperate(info, scope.binding) }
  }
  private canOperate(info: SessionInfo, binding: MobileActorBinding): boolean { return info.readOnly !== true && !!info.ownerId && (info.ownerId === binding.actorId || binding.operateOthers) }
  private async sessions(record: DeviceRecord, hostId: string, projectId?: string): Promise<MobileSession[]> {
    const scopes = record.scopes.filter(scope => scope.hostId === hostId && (!projectId || scope.projectId === projectId))
    if (!scopes.length) throw new Error('Proyecto no autorizado.')
    const values = await this.deps.connection(hostId).api<SessionInfo[]>('GET', '/api/sessions')
    await this.validateDevice(record)
    return values.filter(info => scopes.some(scope => scope.root === info.root)).map(info => this.safeSession(info, scopes, (record.device.capabilities.input || record.device.capabilities.close)))
  }
  private async allowedSession(hostId: string, sessionId: string, record?: DeviceRecord, write = false): Promise<{ connection: Connection; info: SessionInfo }> {
    if (!/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Sesión inválida.')
    const scopes = record ? record.scopes : this.browserScopes
    if (record) await this.validateDevice(record); else await this.browserValid()
    const saved = this.deps.snapshot()
    if (!saved.hosts.some(host => host.id === hostId)) throw new Error('Host no configurado.')
    if (record && !scopes.some(scope => scope.hostId === hostId)) throw new Error('Host no autorizado.')
    const connection = this.deps.connection(hostId)
    const sessions = await connection.api<SessionInfo[]>('GET', '/api/sessions')
    if (record) await this.validateDevice(record); else await this.browserValid()
    const info = sessions.find(info => info.id === sessionId && (record ? scopes.some(scope => scope.hostId === hostId && scope.root === info.root) : saved.projects.some(project => project.hostId === hostId && project.root === info.root)))
    if (!info) throw new Error('Sesión no autorizada.')
    const scope = scopes.find(scope => scope.hostId === hostId && scope.root === info.root)
    if (write && (!scope || !this.canOperate(info, scope.binding))) throw new Error('Sesión de solo lectura.')
    return { connection, info }
  }

  private async handle(req: IncomingMessage, res: ServerResponse, proxy: boolean): Promise<void> {
    try { this.ensureTrust() } catch { json(res, 503, isNativeApiRequest(req) ? mobileError('GATEWAY_UNAVAILABLE', 'Almacén móvil no disponible. El acceso está bloqueado.') : { error: 'Almacén móvil no disponible. El acceso está bloqueado.' }); return }
    if (!this.server) { json(res, 503, isNativeApiRequest(req) ? mobileError('GATEWAY_UNAVAILABLE', 'Gateway pausado.') : { error: 'Gateway pausado.' }); return }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${this.origin.replace('https:', 'wss:')}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`)
    try {
      const url = new URL(req.url || '/', this.origin)
      if (url.pathname.startsWith('/api/v2/')) { res.setHeader('X-Crow-Mobile-API', '1'); await this.keyHandle(req, res, url); return }
      if (url.pathname.startsWith('/api/v1/')) { res.setHeader('X-Crow-Mobile-API', '1'); await this.nativeHandle(req, res, url); return }
      if (proxy) { json(res, 404, { error: 'Ruta no encontrada.' }); return }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/mobile.html' || url.pathname.startsWith('/assets/'))) { this.staticFile(url.pathname, res); return }
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        if (req.headers.origin !== this.origin) { json(res, 403, { error: 'Origen inválido.' }); return }
        const ip = req.socket.remoteAddress || ''
        const attempt = this.failures.get(ip)
        if (attempt && attempt.until > Date.now() && attempt.count >= 5) { json(res, 429, { error: 'Demasiados intentos.' }); return }
        const body = await readJSON(req)
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
        if (!this.pairingCode || Date.now() >= this.pairingExpires || !equalSecret(code, this.pairingCode)) {
          if (this.failures.size >= 256 && !this.failures.has(ip)) this.failures.delete(this.failures.keys().next().value!)
          this.failures.set(ip, { count: attempt && attempt.until > Date.now() ? attempt.count + 1 : 1, until: Date.now() + 10 * 60_000 })
          json(res, 401, { error: 'Código incorrecto o vencido.' }); return
        }
        const scopes: MobileScope[] = []
        for (const project of this.deps.snapshot().projects) {
          try { const binding = await this.actor(project.hostId); if (binding.allowedRoots.includes(project.root)) scopes.push({ projectId: project.id, hostId: project.hostId, root: project.root, hostDigest: this.hostDigest(project.hostId), binding }) } catch { /* Legacy browser remains read-only. Native enrollment requires an individual actor. */ }
        }
        if (scopes.length) await this.validateScopes(scopes)
        if (!this.pairingCode || this.browserSnapshot !== this.snapshotDigest()) throw new Error('La configuración cambió.')
        this.browserScopes = scopes; this.pairingCode = ''
        res.setHeader('Set-Cookie', `crow_mobile=${this.cookieToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`)
        json(res, 200, { ok: true }); return
      }
      if (!this.browserAuth(req)) { json(res, 401, { error: 'Emparejamiento requerido.' }); return }
      await this.browserValid()
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const saved = this.deps.snapshot()
        json(res, 200, { hosts: saved.hosts.map(host => ({ id: host.id, name: host.name, status: this.deps.connection(host.id).status() })), projects: saved.projects.map(({ id, hostId, name, root }) => ({ id, hostId, name, root })) }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const hostId = url.searchParams.get('hostId') || ''
        if (!this.deps.snapshot().hosts.some(host => host.id === hostId)) throw new Error('Host no configurado.')
        const values = await this.deps.connection(hostId).api<SessionInfo[]>('GET', '/api/sessions')
        await this.browserValid()
        json(res, 200, values.filter(info => this.deps.snapshot().projects.some(project => project.hostId === hostId && project.root === info.root))); return
      }
      if (req.method === 'POST' && url.pathname === '/api/wake') {
        if (req.headers.origin !== this.origin) { json(res, 403, { error: 'Origen inválido.' }); return }
        const body = await readJSON(req)
        const { connection } = await this.allowedSession(this.string(body, 'hostId'), this.string(body, 'sessionId'), undefined, true)
        json(res, 200, await connection.api<SessionInfo>('POST', `/api/sessions/${body.sessionId}/wake`)); return
      }
      json(res, 404, { error: 'Ruta no encontrada.' })
    } catch (error) {
      const status = error instanceof MobileHostUnavailableError ? 503 : error instanceof MobileMutationRejectedError ? error.status : 400
      const message = error instanceof MobileHostUnavailableError ? 'Acceso pausado. Reconectá el host o el gateway en Windows.' : error instanceof MobileMutationRejectedError ? error.message : 'Solicitud rechazada. Revisá el emparejamiento y los permisos.'
      if (!isNativeApiRequest(req)) { json(res, status, { error: message }); return }
      const code: MobileErrorCode = error instanceof MobileHostUnavailableError ? 'HOST_UNAVAILABLE' : error instanceof MobileMutationRejectedError && error.status === 429 ? 'RATE_LIMITED' : error instanceof MobileMutationRejectedError && error.status === 409 ? 'REQUEST_CONFLICT' : error instanceof MobileMutationRejectedError && error.status === 401 ? 'DEVICE_REJECTED' : 'INVALID_REQUEST'
      json(res, status, mobileError(code, message))
    }
  }

  private async nativeHandle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.nativeOrigin(req)) { json(res, 403, mobileError('INVALID_ORIGIN', 'Origen inválido.')); return }
    if (req.method === 'POST' && url.pathname === '/api/v1/pair') {
      const body = await readJSON(req)
      const code = this.string(body, 'invitationCode', 32).toUpperCase()
      const label = this.string(body, 'deviceName', 80)
      try {
        const scopes = this.registry.candidate(code, req.socket.remoteAddress || '')
        await this.validateScopes(scopes)
        const { record, credential } = this.registry.pair(code, label)
        json(res, 200, { version: 1, device: record.device, credential, endpoints: this.endpoints })
      } catch (error) { const limited = error instanceof Error && error.message === 'RATE_LIMIT'; json(res, error instanceof MobileHostUnavailableError ? 503 : limited ? 429 : 401, mobileError(error instanceof MobileHostUnavailableError ? 'HOST_UNAVAILABLE' : limited ? 'RATE_LIMITED' : 'DEVICE_REJECTED', 'Invitación inválida o acceso no disponible.')) }
      return
    }
    let record: DeviceRecord
    try { record = await this.nativeAuth(req) } catch (error) { const unavailable = error instanceof MobileHostUnavailableError; json(res, unavailable ? 503 : 401, mobileError(unavailable ? 'HOST_UNAVAILABLE' : 'DEVICE_REJECTED', unavailable ? 'Acceso pausado. Reconectá el host o el gateway en Windows.' : 'Dispositivo revocado o identidad modificada. Volvé a emparejar.')); return }
    const route = url.pathname.slice('/api/v1/'.length)
    if (req.method === 'GET' && route === 'bootstrap') {
      const saved = this.deps.snapshot()
      const hostIds = new Set(record.scopes.map(scope => scope.hostId))
      json(res, 200, { version: 1, device: record.device, hosts: saved.hosts.filter(host => hostIds.has(host.id)).map(host => ({ id: host.id, name: host.name, status: this.deps.connection(host.id).status() })), projects: saved.projects.filter(project => record.scopes.some(scope => scope.projectId === project.id)).map(({ id, hostId, name }) => ({ id, hostId, name })), actor: { label: this.deps.actorLabel?.() || 'Usuario vinculado' }, devices: [record.device], supportedFeatures: MOBILE_SUPPORTED_FEATURES }); return
    }
    if (req.method === 'GET' && route === 'sessions') { json(res, 200, await this.sessions(record, url.searchParams.get('hostId') || '', url.searchParams.get('projectId') || undefined)); return }
    if (req.method === 'GET' && route === 'quotas') {
      if (!record.device.capabilities.quotas) { json(res, 403, mobileError('GRANT_REQUIRED', 'Cuotas no habilitadas para este dispositivo.')); return }
      const quotas = (this.deps.quotas?.() || []).filter(account => account.provider === 'claude' || account.provider === 'codex').slice(0, 64).map(account => ({ id: account.id, label: account.label, provider: account.provider, state: account.state, sampledAt: account.sampledAt, windows: account.windows.slice(0, 16).map(({ label, usedPercent, resetsAt }) => ({ label, usedPercent: typeof usedPercent === 'number' && Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100 ? usedPercent : null, resetsAt })) }))
      json(res, 200, quotas); return
    }
    if (req.method === 'GET' && route === 'notices') {
      const allowed = new Set<string>()
      for (const hostId of new Set(record.scopes.map(scope => scope.hostId))) for (const session of await this.sessions(record, hostId)) allowed.add(`${hostId}:${session.id}`)
      const notices = (this.deps.notices?.() || []).filter(notice => allowed.has(`${notice.hostId}:${notice.sessionId}`)).slice(-100).map(({ id, hostId, sessionId, kind, at, requiresAttention }) => ({ id, hostId, sessionId, kind, at, requiresAttention }))
      await this.validateDevice(record)
      json(res, 200, notices); return
    }
    if (req.method === 'POST' && ['sessions', 'wake', 'close', 'input', 'resize'].includes(route)) {
      const body = await readJSON(req)
      // A short bearer may expire while its request body is being read; never execute using only durable trust.
      await this.nativeAuth(req)
      const credential = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')?.[1]
      const result = await this.executeMutation(record, credential ? this.registry.credentialContext(credential) : undefined, route as MobileMutationRoute, body)
      json(res, result.status, result.body); return
    }
    json(res, 404, mobileError('NOT_FOUND', 'Ruta no encontrada.'))
  }
  /** Adapter boundary: authenticate a transport first, then pass the registry's opaque
   * context (never a serialized client-supplied context) and the complete decrypted body.
   * Replays revalidate current device authority but do not reexecute an accepted action.
   */
  async executeMutation(record: DeviceRecord, context: MobileMutationContext | undefined, route: MobileMutationRoute, body: Record<string, unknown>): Promise<MobileMutationResult> {
    const authorize = async (): Promise<void> => {
      await this.validateDevice(record)
      if (record.publicKey && (!context || !this.registry.contextActive(context, record))) throw new MobileMutationRejectedError(401, 'El contexto de autorización venció. Renovalo antes de otra acción.')
    }
    await authorize()
    if (!['sessions', 'wake', 'close', 'input', 'resize'].includes(route)) throw new MobileMutationRejectedError(400, 'Operación inválida.')
    if (!record.publicKey) return this.mutationOperation(record, route, body)
    const { requestId, ...operation } = body
    const result = await this.mutations.run(context!, requestId, route, body, async () => {
      await authorize()
      return this.mutationOperation(record, route, operation)
    })
    await authorize()
    return result
  }
  private async mutationOperation(record: DeviceRecord, route: MobileMutationRoute, body: Record<string, unknown>): Promise<MobileMutationResult> {
      if (route === 'input' || route === 'resize') {
        if (!record.device.capabilities.input) return { status: 403, body: mobileError('GRANT_REQUIRED', 'Entrada no habilitada.') }
        const stream = this.clients.get(this.string(body, 'streamId'))
        if (!stream || stream.device !== record || stream.client.readyState !== WebSocket.OPEN) throw new Error('Terminal desconectada.')
        this.validateStreamCredential(stream)
        await this.allowedSession(stream.hostId, stream.sessionId, record, true)
        stream.connection.send(stream.streamId, this.inputFrame(body, route))
        return { status: 200, body: { ok: true } }
      }
      const hostId = this.string(body, 'hostId')
      if (route === 'sessions') {
        if (!record.device.capabilities.create) return { status: 403, body: mobileError('GRANT_REQUIRED', 'Creación no habilitada.') }
        const projectId = this.string(body, 'projectId')
        const scope = record.scopes.find(scope => scope.projectId === projectId && scope.hostId === hostId)
        if (!scope || (body.agent !== 'claude' && body.agent !== 'codex') || body.mode !== undefined || body.root !== undefined || Object.keys(body).some(key => !['hostId', 'projectId', 'agent'].includes(key))) throw new Error('Creación inválida.')
        await this.validateDevice(record)
        const info = await this.deps.connection(hostId).api<SessionInfo>('POST', '/api/sessions', { agent: body.agent, mode: 'normal', root: scope.root })
        await this.validateDevice(record)
        return { status: 200, body: this.safeSession(info, [scope], (record.device.capabilities.input || record.device.capabilities.close)) }
      }
      if (!record.device.capabilities[route === 'close' ? 'close' : 'input']) return { status: 403, body: mobileError('GRANT_REQUIRED', 'Operación no habilitada.') }
      const sessionId = this.string(body, 'sessionId')
      const { connection } = await this.allowedSession(hostId, sessionId, record, true)
      if (route === 'close') {
        await connection.api('DELETE', `/api/sessions/${sessionId}`)
        for (const stream of this.clients.values()) if (stream.hostId === hostId && stream.sessionId === sessionId) stream.client.close()
        return { status: 200, body: { ok: true } }
      }
      const info = await connection.api<SessionInfo>('POST', `/api/sessions/${sessionId}/wake`)
      await this.validateDevice(record)
      return { status: 200, body: this.safeSession(info, record.scopes.filter(scope => scope.hostId === hostId), (record.device.capabilities.input || record.device.capabilities.close)) }
  }
  private async keyHandle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.nativeOrigin(req)) { json(res, 403, mobileError('INVALID_ORIGIN', 'Origen inválido.')); return }
    if (req.method !== 'POST' || !['pair', 'device-challenge', 'device-renew'].includes(url.pathname.slice('/api/v2/'.length))) { json(res, 404, mobileError('NOT_FOUND', 'Ruta no encontrada.')); return }
    try {
      const body = await readJSON(req), route = url.pathname.slice('/api/v2/'.length)
      const fields = route === 'pair' ? ['invitationCode', 'deviceName', 'publicKey'] : route === 'device-challenge' ? ['deviceId'] : ['deviceId', 'challengeId', 'signature']
      if (Object.keys(body).some(key => !fields.includes(key))) throw new Error('Solicitud inválida.')
      if (route === 'pair') {
        const code = this.string(body, 'invitationCode', 32).toUpperCase()
        await this.validateScopes(this.registry.candidate(code, req.socket.remoteAddress || ''))
        const paired = this.registry.pairKey(code, this.string(body, 'deviceName', 80), this.string(body, 'publicKey', 124))
        json(res, 200, { version: 2, device: paired.record.device, credential: paired.credential, credentialExpiresAt: paired.credentialExpiresAt, endpoints: this.endpoints }); return
      }
      const id = this.string(body, 'deviceId')
      if (route === 'device-challenge') {
        const record = this.registry.keyDevice(id)
        await this.validateDevice(record)
        json(res, 200, this.registry.challenge(id, this.gatewayId, req.socket.remoteAddress || '')); return
      }
      const record = this.registry.prove(id, this.string(body, 'challengeId'), this.string(body, 'signature', 112))
      await this.validateDevice(record)
      json(res, 200, { version: 2, ...this.registry.issueCredential(record) })
    } catch (error) { const limited = error instanceof Error && error.message === 'RATE_LIMIT'; json(res, error instanceof MobileHostUnavailableError ? 503 : limited ? 429 : 401, mobileError(error instanceof MobileHostUnavailableError ? 'HOST_UNAVAILABLE' : limited ? 'RATE_LIMITED' : 'DEVICE_REJECTED', error instanceof MobileHostUnavailableError ? 'Acceso pausado. Comprobá Crow y el host en Windows.' : 'Dispositivo o prueba no autorizados. La invitación o el desafío pueden haber vencido.')) }
  }
  private validateStreamCredential(stream: StreamRecord): void {
    // V2 bearer authenticates the upgrade only. Established streams remain bound to
    // durable key trust and live scopes, revalidated on every action/output and audit.
    // Legacy v1 has no renewable key identity; its original credential TTL still applies.
    if (stream.device && !stream.device.publicKey && (!stream.credentialExpiresAt || stream.credentialExpiresAt <= Date.now())) throw new Error('Credencial de acceso vencida. Reconectá la terminal.')
  }
  private inputFrame(body: Record<string, unknown>, type: 'input' | 'resize'): unknown {
    if (type === 'input') {
      const data = this.string(body, 'data', 4096)
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || Buffer.from(data, 'base64').length > 2048) throw new Error('Entrada inválida.')
      return { type: 'input', data }
    }
    if (!Number.isInteger(body.cols) || !Number.isInteger(body.rows) || Number(body.cols) < 1 || Number(body.cols) > 500 || Number(body.rows) < 1 || Number(body.rows) > 500) throw new Error('Tamaño inválido.')
    return { type: 'resize', cols: body.cols, rows: body.rows }
  }

  private staticFile(pathname: string, res: ServerResponse): void {
    const root = resolve(__dirname, '../renderer')
    const name = pathname === '/' ? 'mobile.html' : pathname.slice(1)
    const path = resolve(root, name)
    if (path !== resolve(root, 'mobile.html') && !path.startsWith(resolve(root, 'assets') + sep)) { json(res, 404, { error: 'No encontrado.' }); return }
    try {
      const body = readFileSync(path)
      const type = path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body)
    } catch { json(res, 404, { error: 'Vista móvil no disponible.' }) }
  }
  private async auditStreams(): Promise<void> {
    for (const stream of this.clients.values()) {
      try { this.validateStreamCredential(stream); await this.allowedSession(stream.hostId, stream.sessionId, stream.device) } catch { stream.client.terminate() }
    }
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, proxy: boolean): Promise<void> {
    try {
      const url = new URL(req.url || '/', this.origin)
      const native = url.pathname === '/api/v1/stream'
      if (!native && (proxy || url.pathname !== '/ws' || !this.browserAuth(req) || req.headers.origin !== this.origin)) throw new Error('No autorizado.')
      const device = native ? await this.nativeAuth(req) : undefined
      const hostId = url.searchParams.get('hostId') || ''
      const sessionId = url.searchParams.get('sessionId') || ''
      const from = Number(url.searchParams.get('from') || 0)
      if (!Number.isSafeInteger(from) || from < 0 || url.searchParams.has('token') || url.searchParams.has('credential')) throw new Error('Secuencia inválida.')
      const { connection } = await this.allowedSession(hostId, sessionId, device)
      if (this.clients.size >= 32) throw new Error('Demasiadas terminales.')
      this.sockets.handleUpgrade(req, socket, head, client => {
        const streamId = randomUUID()
        const credential = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')?.[1]
        const stream: StreamRecord = { client, connection, streamId, hostId, sessionId, device, browser: !native, credentialExpiresAt: credential ? this.registry.credentialExpiry(credential) : undefined, mutationContext: credential ? this.registry.credentialContext(credential) : undefined }
        this.clients.set(streamId, stream)
        let inputBusy = 0, inputRequestId: unknown
        client.on('message', raw => {
          let body: Record<string, unknown>
          try { body = JSON.parse(raw.toString()) } catch { client.close(1008, 'Mensaje inválido'); return }
          if (!body || (body.type !== 'input' && body.type !== 'resize')) { client.close(1008, 'Mensaje inválido'); return }
          // Preserve input ordering; only bounded duplicates of the same v2 attempt may coalesce.
          if (inputBusy && (!device?.publicKey || !body.requestId || body.requestId !== inputRequestId || inputBusy >= 32)) { client.close(1008, 'Entrada concurrente'); return }
          if (!inputBusy) inputRequestId = body.requestId
          inputBusy++
          void (async () => {
            try {
              if (device && !device.device.capabilities.input) throw new Error('Solo lectura.')
              this.validateStreamCredential(stream)
              if (device?.publicKey) {
                const { type, ...operation } = body
                const result = await this.executeMutation(device, stream.mutationContext, type as 'input' | 'resize', { ...operation, streamId })
                if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'mutation-result', requestId: body.requestId, status: result.status, result: result.body }))
                return
              }
              await this.allowedSession(hostId, sessionId, device, true)
              connection.send(streamId, this.inputFrame(body, body.type as 'input' | 'resize'))
            } catch (error) {
              if (device?.publicKey && error instanceof MobileMutationRejectedError && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'mutation-result', status: error.status, result: { error: error.message } }))
              else client.close(1008, 'Entrada no autorizada')
            } finally { if (!--inputBusy) inputRequestId = undefined }
          })()
        })
        client.on('close', () => { connection.detach(streamId); this.clients.delete(streamId) })
        let queued = 0
        let queueBytes = 0
        let frames = Promise.resolve()
        void connection.attach(streamId, sessionId, from, frame => {
          const bytes = Buffer.byteLength(JSON.stringify(frame))
          if (++queued > 128 || (queueBytes += bytes) > 1024 * 1024 || client.bufferedAmount > 1024 * 1024) { client.close(1013, 'Consumidor lento'); return }
          frames = frames.then(async () => {
            try {
              if (device) await this.validateDevice(device); else await this.browserValid()
              this.validateStreamCredential(stream)
              if (client.readyState !== WebSocket.OPEN) return
              let output: unknown = frame
              if (native && device) {
                if (frame.type === 'output') {
                  if (!Number.isSafeInteger(frame.seq) || Number(frame.seq) < 0 || typeof frame.data !== 'string') throw new Error('Salida inválida.')
                  output = { type: 'output', seq: frame.seq, data: frame.data }
                } else if (frame.type === 'state' && frame.info) {
                  output = { type: 'state', info: this.safeSession(frame.info, device.scopes.filter(scope => scope.hostId === hostId), device.device.capabilities.input || device.device.capabilities.close) }
                } else if (frame.type === 'disconnected') output = { type: 'disconnected' }
                else throw new Error('Salida inválida.')
              }
              client.send(JSON.stringify(output))
            } catch { client.close(1008, 'Identidad revocada') } finally { --queued; queueBytes -= bytes }
          })
        }).then(async () => {
          if (device) await this.validateDevice(device); else await this.browserValid()
          this.validateStreamCredential(stream)
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'ready', streamId }))
          else connection.detach(streamId)
        }).catch(() => { client.close(); connection.detach(streamId) })
      })
    } catch (error) { socket.write(`HTTP/1.1 ${error instanceof MobileHostUnavailableError ? '503 Service Unavailable' : '403 Forbidden'}\r\nX-Crow-Mobile-API: 1\r\nConnection: close\r\n\r\n`); socket.destroy() }
  }
}
