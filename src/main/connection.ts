import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import type { ConnectionStatus, Host, RemoteEvent, TerminalFrame } from '../shared/types'
import { Store } from './store'
import { HostCredentialVault } from './host-credential-vault'
import type { AccessStatus, AccessIdentity, AccessUserInput, AccessCredentialResult, AccessPrincipal } from '../shared/access'
import { EncryptedSshTunnel, isEncryptedKey, PassphraseRequiredError } from './encrypted-ssh'
import { PassphraseVault } from './passphrase-vault'
import { remoteApiError } from './remote-errors'
import { isTransportFailure } from './transport-failure'

const execFileAsync = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => port ? resolve(port) : reject(new Error('No se pudo reservar un puerto local.')))
    })
  })
}

export class Connection {
  readonly host: Host
  private store: Store
  private vault: PassphraseVault
  private onStatus: (hostId: string, status: ConnectionStatus) => void
  private onEvent: (hostId: string, event: RemoteEvent) => void
  private wantEventMessages: () => boolean
  private onPassphraseRequired: (hostId: string) => void
  private tunnel?: ChildProcess
  private encryptedTunnel?: EncryptedSshTunnel
  private pendingPassphrase?: string
  private localPort = 0
  private token = ''
  private credentialVault: HostCredentialVault
  private currentStatus: ConnectionStatus = 'disconnected'
  private desired = false
  private connecting?: Promise<void>
  private retryTimer?: NodeJS.Timeout
  private pollTimer?: NodeJS.Timeout
  private delay = 1000
  private streams = new Map<string, WebSocket>()
  private polling = false

  constructor(host: Host, store: Store, vault: PassphraseVault, onStatus: (hostId: string, status: ConnectionStatus) => void, onEvent: (hostId: string, event: RemoteEvent) => void, onPassphraseRequired: (hostId: string) => void, wantEventMessages: () => boolean, credentialVault = new HostCredentialVault()) {
    this.credentialVault = credentialVault
    this.host = host
    this.store = store
    this.vault = vault
    this.onStatus = onStatus
    this.onEvent = onEvent
    this.wantEventMessages = wantEventMessages
    this.onPassphraseRequired = onPassphraseRequired
  }

  status(): ConnectionStatus { return this.currentStatus }

  connect(): Promise<void> {
    this.desired = true
    if (this.currentStatus === 'connected') return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = this.establish().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  async submitPassphrase(passphrase: string): Promise<void> {
    if (!this.host.identity || !passphrase) throw new Error('Ingresá la frase de la llave SSH.')
    await this.connecting?.catch(() => undefined)
    this.pendingPassphrase = passphrase
    await this.connect()
  }

  stop(): void {
    this.desired = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    for (const stream of this.streams.values()) stream.close()
    this.streams.clear()
    this.closeTransport()
    this.setStatus('disconnected')
  }

  private closeTransport(): void {
    const tunnel = this.tunnel
    this.tunnel = undefined
    tunnel?.kill()
    const encryptedTunnel = this.encryptedTunnel
    this.encryptedTunnel = undefined
    encryptedTunnel?.close()
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.currentStatus !== status) {
      this.currentStatus = status
      this.onStatus(this.host.id, status)
    }
  }

  private sshOptions(): string[] {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-p', String(this.host.port)]
    if (this.host.identity) args.push('-i', this.host.identity)
    return args
  }

  private async establish(): Promise<void> {
    this.setStatus('connecting')
    const wasUserSubmission = this.pendingPassphrase !== undefined
    try {
      let stdout: string
      const individualCredential = this.credentialVault.get(this.host.id, this.credentialTarget())
      let passphrase: string | undefined
      if (this.host.identity && isEncryptedKey(this.host.identity)) {
        passphrase = this.pendingPassphrase || this.vault.get(this.host.id, this.host.identity)
        this.pendingPassphrase = undefined
        if (!passphrase) throw new PassphraseRequiredError()
        try {
          let opened: EncryptedSshTunnel | undefined
          opened = await EncryptedSshTunnel.open(this.host, passphrase, () => {
            if (this.encryptedTunnel === opened) this.lost()
          }, individualCredential || '')
          this.encryptedTunnel = opened
        } catch (error) {
          if (error instanceof PassphraseRequiredError) {
            this.vault.forget(this.host.id)
          }
          throw error
        }
        stdout = this.encryptedTunnel.token
        this.localPort = this.encryptedTunnel.port
      } else {
        stdout = individualCredential || ''
        this.localPort = await freePort()
        const args = [...this.sshOptions(), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-N', '-L', `127.0.0.1:${this.localPort}:127.0.0.1:${this.host.remotePort}`, this.host.target]
        const tunnel = spawn('ssh', args, { windowsHide: true, stdio: 'ignore' })
        this.tunnel = tunnel
        tunnel.once('exit', () => { if (this.tunnel === tunnel) this.lost() })
        tunnel.once('error', () => { if (this.tunnel === tunnel) this.lost() })
      }
      if (!this.desired) throw new Error('Conexión cancelada.')
      this.token = stdout.trim()
      if (this.token && !/^[0-9a-f]{32}$/.test(this.token)) throw new Error('El servicio remoto no entregó un token válido.')
      let ready = false
      for (let attempt = 0; attempt < 25; attempt++) {
        if (this.tunnel && this.tunnel.exitCode !== null) break
        try {
          const response = await fetch(this.baseURL('/api/access'), { headers: this.headers(), signal: AbortSignal.timeout(1000) })
          if (response.ok || response.status === 404 || response.status === 401) { ready = true; break }
        } catch { /* Wait for the SSH forward. */ }
        await sleep(400)
      }
      if (!ready) throw new Error('No se pudo abrir el túnel SSH o el servicio remoto no responde.')
      if (!this.desired) throw new Error('Conexión cancelada.')
      const accessResponse = await fetch(this.baseURL('/api/access'), { signal: AbortSignal.timeout(2500) })
      if (accessResponse.ok && (await accessResponse.json() as AccessStatus).enabled) {
        if (!individualCredential) throw new AccessCredentialRequiredError()
        const identity = await fetch(this.baseURL('/api/access/me'), { headers: this.headers(), signal: AbortSignal.timeout(2500) })
        if (!identity.ok) throw new AccessCredentialRequiredError()
      }
      if (!individualCredential) {
        this.token = this.encryptedTunnel ? await this.encryptedTunnel.readBootstrapToken() : (await execFileAsync('ssh', [...this.sshOptions(), this.host.target, 'cat ~/.local/share/crow-harness/token'], { timeout: 15000, maxBuffer: 1024, windowsHide: true })).stdout.trim()
        if (!/^[0-9a-f]{32}$/.test(this.token)) throw new Error('Token remoto invalido.')
      }
      if (passphrase && this.host.identity) this.vault.set(this.host.id, this.host.identity, passphrase)
      this.delay = 1000
      this.setStatus('connected')
      this.pollTimer = setInterval(() => void this.pollEvents(), 3000)
      void this.pollEvents()
    } catch (error) {
      this.pendingPassphrase = undefined
      this.closeTransport()
      if (error instanceof PassphraseRequiredError) {
        this.setStatus('auth-required')
        if (wasUserSubmission) throw new Error('La frase de la llave SSH es incorrecta.')
        setTimeout(() => { if (this.desired) this.onPassphraseRequired(this.host.id) }, 0)
        return
      }
      this.setStatus('disconnected')
      if (!(error instanceof AccessCredentialRequiredError)) this.scheduleRetry()
      throw error
    }
  }

  private lost(): void {
    if (this.currentStatus === 'disconnected') return
    this.closeTransport()
    if (this.pollTimer) clearInterval(this.pollTimer)
    for (const stream of this.streams.values()) stream.close()
    this.streams.clear()
    this.setStatus('disconnected')
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (!this.desired || this.retryTimer) return
    const wait = this.delay + Math.floor(Math.random() * 400)
    this.delay = Math.min(30000, this.delay * 2)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.connect().catch(() => undefined)
    }, wait)
  }

  private credentialTarget(): string { return `${this.host.target}:${this.host.port}:${this.host.remotePort}` }
  async setAccessCredential(credential: string): Promise<void> {
    this.credentialVault.set(this.host.id, this.credentialTarget(), credential.trim())
    this.stop()
    await this.connect()
  }
  async accessStatus(): Promise<AccessStatus> { return this.api('GET', '/api/access') }
  async accessIdentity(): Promise<AccessIdentity> { return this.api('GET', '/api/access/me') }
  async enableAccess(label: string): Promise<AccessCredentialResult> {
    const result = await this.api<AccessCredentialResult>('POST', '/api/access/enable', { label })
    await this.setAccessCredential(result.credential)
    return result
  }
  async listAccessUsers(): Promise<AccessPrincipal[]> { return this.api('GET', '/api/access/users') }
  async createAccessUser(input: AccessUserInput): Promise<AccessCredentialResult> { return this.api('POST', '/api/access/users', input) }
  async revokeAccessUser(id: string): Promise<void> { await this.api('DELETE', `/api/access/users/${encodeURIComponent(id)}`) }
  async assignSessionOwner(id: string, ownerId: string): Promise<void> { await this.api('POST', `/api/access/sessions/${encodeURIComponent(id)}/owner`, { ownerId }) }

  private baseURL(path: string): string { return `http://127.0.0.1:${this.localPort}${path}` }
  private headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}` } }

  private async recoverTransport(error: unknown): Promise<void> {
    if (!isTransportFailure(error) || this.currentStatus !== 'connected' || !this.desired) return
    const port = this.localPort
    try {
      const response = await fetch(this.baseURL('/api/health'), {
        headers: this.headers(), signal: AbortSignal.timeout(2500)
      })
      if (!response.ok && this.localPort === port) this.lost()
    } catch {
      if (this.localPort === port) this.lost()
    }
  }

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.currentStatus !== 'connected') throw new Error('Host desconectado.')
    try {
      const response = await fetch(this.baseURL(path), {
        method,
        headers: { ...this.headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      })
      if (!response.ok) {
        const detail = await response.text()
        if (response.status === 401) this.lost()
        throw remoteApiError(response.status, detail, method, path)
      }
      return response.json() as Promise<T>
    } catch (error) {
      await this.recoverTransport(error)
      throw error
    }
  }

  async binary(path: string): Promise<{ data: string; type: string; url: string }> {
    if (this.currentStatus !== 'connected') throw new Error('Host desconectado.')
    try {
      const response = await fetch(this.baseURL(path), { headers: this.headers(), signal: AbortSignal.timeout(30000) })
      if (!response.ok) {
        const detail = await response.text()
        if (response.status === 401) this.lost()
        throw new Error(detail.trim() || `Error ${response.status}`)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      return { data: bytes.toString('base64'), type: response.headers.get('content-type') || 'application/octet-stream', url: response.headers.get('x-browser-url') || '' }
    } catch (error) {
      await this.recoverTransport(error)
      throw error
    }
  }

  async uploadLocalFile(root: string, directory: string, localPath: string): Promise<string> {
    if (this.currentStatus !== 'connected') throw new Error('Host desconectado.')
    if (!isAbsolute(localPath)) throw new Error('Ruta local inválida.')
    const info = await stat(localPath)
    if (!info.isFile()) throw new Error('Solo se pueden subir archivos, no carpetas.')
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('El archivo supera el límite de 512 MiB.')
    const name = basename(localPath)
    const query = new URLSearchParams({ root, directory, name })
    const source = createReadStream(localPath)
    try {
      const response = await fetch(this.baseURL(`/api/files/upload?${query}`), {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/octet-stream', 'Content-Length': String(info.size) },
        body: Readable.toWeb(source) as BodyInit,
        duplex: 'half',
        signal: AbortSignal.timeout(30 * 60 * 1000)
      } as RequestInit & { duplex: 'half' })
      if (!response.ok) {
        if (response.status === 409) throw new Error('Ya existe un archivo con ese nombre en la carpeta remota.')
        if (response.status === 413) throw new Error('El archivo supera el límite de 512 MiB.')
        throw remoteApiError(response.status, await response.text(), 'POST', '/api/files/upload')
      }
      return name
    } finally {
      source.destroy()
    }
  }

  async downloadFile(root: string, path: string, destination: string): Promise<void> {
    if (this.currentStatus !== 'connected') throw new Error('Host desconectado.')
    const query = new URLSearchParams({ root, path })
    const response = await fetch(this.baseURL(`/api/files/download?${query}`), {
      headers: this.headers(), signal: AbortSignal.timeout(30 * 60 * 1000)
    })
    if (!response.ok) throw remoteApiError(response.status, await response.text(), 'GET', '/api/files/download')
    if (!response.body) throw new Error('El servidor no entregó el archivo.')
    const temporary = join(dirname(destination), `.crow-download-${randomUUID()}.part`)
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary, { flags: 'wx' }))
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async attach(id: string, sessionId: string, from: number, emit: (frame: TerminalFrame) => void): Promise<void> {
    if (this.currentStatus !== 'connected') throw new Error('Host desconectado.')
    const url = `ws://127.0.0.1:${this.localPort}/api/sessions/${encodeURIComponent(sessionId)}/stream?from=${Math.max(0, from)}`
    const socket = new WebSocket(url, { headers: this.headers(), handshakeTimeout: 10000 })
    this.streams.set(id, socket)
    socket.on('message', (raw) => {
      try { emit(JSON.parse(raw.toString()) as TerminalFrame) } catch { /* Ignore malformed frames. */ }
    })
    socket.on('close', () => { this.streams.delete(id); emit({ type: 'disconnected' }) })
    socket.on('error', () => { socket.terminate() })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
  }

  ownsStream(id: string): boolean { return this.streams.has(id) }
  detach(id: string): void { this.streams.get(id)?.close(); this.streams.delete(id) }

  send(id: string, value: unknown): void {
    const socket = this.streams.get(id)
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Terminal desconectada.')
    socket.send(JSON.stringify(value))
  }

  private async pollEvents(): Promise<void> {
    if (this.polling || this.currentStatus !== 'connected') return
    this.polling = true
    try {
      const after = this.store.eventCursor(this.host.id)
      const events = await this.api<RemoteEvent[]>('GET', `/api/events?after=${after}${this.wantEventMessages() ? '&includeMessage=true' : ''}`)
      for (const event of events) {
        this.onEvent(this.host.id, event)
      }
    } catch (error) {
      await this.recoverTransport(error)
    } finally {
      this.polling = false
    }
  }
}

export class AccessCredentialRequiredError extends Error { constructor() { super('Este host requiere una credencial individual de Crow. Ped�sela al administrador.') } }
