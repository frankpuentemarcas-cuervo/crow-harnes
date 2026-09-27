import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import type { ConnectionStatus, Host, Notice, RemoteEvent, TerminalFrame } from '../shared/types'
import { Store } from './store'
import { EncryptedSshTunnel, isEncryptedKey, PassphraseRequiredError } from './encrypted-ssh'
import { PassphraseVault } from './passphrase-vault'
import { remoteApiError } from './remote-errors'

const execFileAsync = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  private onNotice: (notice: Notice) => void
  private onPassphraseRequired: (hostId: string) => void
  private tunnel?: ChildProcess
  private encryptedTunnel?: EncryptedSshTunnel
  private pendingPassphrase?: string
  private localPort = 0
  private token = ''
  private currentStatus: ConnectionStatus = 'disconnected'
  private desired = false
  private connecting?: Promise<void>
  private retryTimer?: NodeJS.Timeout
  private pollTimer?: NodeJS.Timeout
  private delay = 1000
  private streams = new Map<string, WebSocket>()
  private polling = false

  constructor(host: Host, store: Store, vault: PassphraseVault, onStatus: (hostId: string, status: ConnectionStatus) => void, onNotice: (notice: Notice) => void, onPassphraseRequired: (hostId: string) => void) {
    this.host = host
    this.store = store
    this.vault = vault
    this.onStatus = onStatus
    this.onNotice = onNotice
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
    this.tunnel?.kill()
    this.tunnel = undefined
    this.encryptedTunnel?.close()
    this.encryptedTunnel = undefined
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
      let passphrase: string | undefined
      if (this.host.identity && isEncryptedKey(this.host.identity)) {
        passphrase = this.pendingPassphrase || this.vault.get(this.host.id, this.host.identity)
        this.pendingPassphrase = undefined
        if (!passphrase) throw new PassphraseRequiredError()
        try {
          this.encryptedTunnel = await EncryptedSshTunnel.open(this.host, passphrase, () => this.lost())
        } catch (error) {
          if (error instanceof PassphraseRequiredError) {
            this.vault.forget(this.host.id)
          }
          throw error
        }
        stdout = this.encryptedTunnel.token
        this.localPort = this.encryptedTunnel.port
      } else {
        const result = await execFileAsync('ssh', [...this.sshOptions(), this.host.target, 'cat ~/.local/share/crow-harness/token'], { timeout: 15000, maxBuffer: 1024, windowsHide: true })
        stdout = result.stdout
        this.localPort = await freePort()
        const args = [...this.sshOptions(), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-N', '-L', `127.0.0.1:${this.localPort}:127.0.0.1:${this.host.remotePort}`, this.host.target]
        const tunnel = spawn('ssh', args, { windowsHide: true, stdio: 'ignore' })
        this.tunnel = tunnel
        tunnel.once('exit', () => this.lost())
        tunnel.once('error', () => this.lost())
      }
      if (!this.desired) throw new Error('Conexión cancelada.')
      this.token = stdout.trim()
      if (!/^[0-9a-f]{32}$/.test(this.token)) throw new Error('El servicio remoto no entregó un token válido.')
      let ready = false
      for (let attempt = 0; attempt < 25; attempt++) {
        if (this.tunnel && this.tunnel.exitCode !== null) break
        try {
          const response = await fetch(this.baseURL('/api/health'), { headers: this.headers(), signal: AbortSignal.timeout(1000) })
          if (response.ok) { ready = true; break }
        } catch { /* Wait for the SSH forward. */ }
        await sleep(400)
      }
      if (!ready) throw new Error('No se pudo abrir el túnel SSH o el servicio remoto no responde.')
      if (!this.desired) throw new Error('Conexión cancelada.')
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
      this.scheduleRetry()
      throw error
    }
  }

  private lost(): void {
    if (this.currentStatus === 'disconnected' && !this.desired) return
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

  private baseURL(path: string): string { return `http://127.0.0.1:${this.localPort}${path}` }
  private headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}` } }

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.currentStatus !== 'connected') throw new Error('Host desconectado.')
    const response = await fetch(this.baseURL(path), {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) throw remoteApiError(response.status, await response.text(), method, path)
    return response.json() as Promise<T>
  }

  async binary(path: string): Promise<{ data: string; type: string; url: string }> {
    if (this.currentStatus !== 'connected') throw new Error('Host desconectado.')
    const response = await fetch(this.baseURL(path), { headers: this.headers(), signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error((await response.text()).trim() || `Error ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    return { data: bytes.toString('base64'), type: response.headers.get('content-type') || 'application/octet-stream', url: response.headers.get('x-browser-url') || '' }
  }

  async attach(id: string, sessionId: string, from: number, emit: (frame: TerminalFrame) => void): Promise<void> {
    if (this.currentStatus !== 'connected') throw new Error('Host desconectado.')
    const url = `ws://127.0.0.1:${this.localPort}/api/sessions/${encodeURIComponent(sessionId)}/stream?from=${Math.max(0, from)}`
    const socket = new WebSocket(url, { headers: this.headers() })
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
      const events = await this.api<RemoteEvent[]>('GET', `/api/events?after=${after}`)
      for (const event of events) {
        const notice = this.store.recordEvent(this.host.id, event)
        if (notice) this.onNotice(notice)
      }
    } catch {
      this.closeTransport()
    } finally {
      this.polling = false
    }
  }
}
