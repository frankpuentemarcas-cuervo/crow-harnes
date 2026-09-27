import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { Client, utils } from 'ssh2'
import type { Host } from '../shared/types'

const execFileAsync = promisify(execFile)

export class PassphraseRequiredError extends Error {
  constructor() { super('La llave SSH necesita su frase de protección.') }
}

export function isEncryptedKey(identity: string): boolean {
  const parsed = utils.parseKey(readFileSync(identity))
  if (!(parsed instanceof Error)) return false
  if (/encrypted.*no passphrase|no passphrase.*encrypted/i.test(parsed.message)) return true
  throw new Error(`No se pudo leer la llave SSH: ${parsed.message}`)
}

async function sshConfig(host: Host): Promise<{ hostname: string; username: string; port: number; lookup: string[] }> {
  const { stdout } = await execFileAsync('ssh', ['-G', '-p', String(host.port), host.target], { windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024 })
  const settings = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const space = line.indexOf(' ')
    if (space > 0 && !settings.has(line.slice(0, space))) settings.set(line.slice(0, space), line.slice(space + 1).trim())
  }
  if ((settings.get('proxyjump') && settings.get('proxyjump') !== 'none') || (settings.get('proxycommand') && settings.get('proxycommand') !== 'none')) {
    throw new Error('Las llaves cifradas con ProxyJump/ProxyCommand aún no son compatibles; usá ssh-agent para ese host.')
  }
  const hostname = settings.get('hostname') || host.target.split('@').at(-1) || ''
  const username = settings.get('user') || host.target.split('@')[0]
  const port = Number(settings.get('port') || host.port)
  const alias = settings.get('hostkeyalias')
  const lookups = [alias && alias !== 'none' ? alias : hostname, host.target.split('@').at(-1) || hostname]
  return { hostname, username, port, lookup: [...new Set(lookups)].map((name) => port === 22 ? name : `[${name}]:${port}`) }
}

async function knownHostKeys(lookups: string[]): Promise<Buffer[]> {
  const keys: Buffer[] = []
  for (const lookup of lookups) {
    try {
      const { stdout } = await execFileAsync('ssh-keygen', ['-F', lookup], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 })
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith('#') || line.startsWith('@')) continue
        const fields = line.trim().split(/\s+/)
        if (fields.length >= 3) keys.push(Buffer.from(fields[2], 'base64'))
      }
    } catch { /* No trusted key for this lookup. */ }
  }
  if (!keys.length) throw new Error('El host SSH no está en known_hosts. Conectate una vez con ssh.exe y verificá su huella.')
  return keys
}

export class EncryptedSshTunnel {
  private client = new Client()
  private server?: Server
  private closed = false
  private onLost: () => void
  port = 0
  token = ''

  private constructor(onLost: () => void) { this.onLost = onLost }

  static async open(host: Host, passphrase: string, onLost: () => void): Promise<EncryptedSshTunnel> {
    const tunnel = new EncryptedSshTunnel(onLost)
    try {
      const config = await sshConfig(host)
      const trusted = await knownHostKeys(config.lookup)
      const privateKey = readFileSync(host.identity!)
      const parsed = utils.parseKey(privateKey, passphrase)
      if (parsed instanceof Error) throw new PassphraseRequiredError()
      await new Promise<void>((resolve, reject) => {
        tunnel.client.once('ready', resolve)
        tunnel.client.once('error', reject)
        tunnel.client.connect({
          host: config.hostname, port: config.port, username: config.username,
          privateKey, passphrase, readyTimeout: 15000,
          keepaliveInterval: 15000, keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => trusted.some((item) => item.equals(key))
        })
      })
      tunnel.client.on('close', () => { if (!tunnel.closed) tunnel.onLost() })
      tunnel.client.on('error', () => { if (!tunnel.closed) tunnel.onLost() })
      tunnel.token = await tunnel.readToken()
      tunnel.server = createServer((socket) => {
        tunnel.client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, '127.0.0.1', host.remotePort, (error, channel) => {
          if (error) { socket.destroy(); return }
          socket.on('error', () => channel.destroy())
          channel.on('error', () => socket.destroy())
          socket.pipe(channel).pipe(socket)
        })
      })
      await new Promise<void>((resolve, reject) => {
        tunnel.server!.once('error', reject)
        tunnel.server!.listen(0, '127.0.0.1', resolve)
      })
      const address = tunnel.server.address()
      if (!address || typeof address === 'string') throw new Error('No se pudo abrir el túnel local.')
      tunnel.port = address.port
      return tunnel
    } catch (error) {
      tunnel.close()
      throw error
    }
  }

  private readToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.exec('cat ~/.local/share/crow-harness/token', (error, stream) => {
        if (error) { reject(error); return }
        let output = ''
        stream.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8')
          if (output.length > 1024) { stream.close(); reject(new Error('Token remoto inválido.')) }
        })
        stream.on('close', (code: number) => code === 0 ? resolve(output.trim()) : reject(new Error('No se pudo leer el token del servicio remoto.')))
        stream.on('error', reject)
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.server?.close()
    this.client.end()
  }
}
