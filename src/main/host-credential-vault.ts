import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Per-host Crow identities. Never serialize plaintext into workspace/state JSON. */
export class HostCredentialVault {
  private path: string
  private data: Record<string, { target: string; encrypted: string }> = {}
  constructor(path = join(app.getPath('userData'), 'host-access-credentials.json')) {
    this.path = path
    if (existsSync(path)) {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('El almacén de credenciales requiere revisión.')
      this.data = value as typeof this.data
    }
  }
  get(hostId: string, target: string): string | undefined {
    const saved = this.data[hostId]
    if (!saved || saved.target !== target) return
    if (!safeStorage.isEncryptionAvailable()) throw new Error('El almacenamiento seguro no está disponible.')
    return safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64'))
  }
  set(hostId: string, target: string, credential: string): void {
    if (!/^[0-9a-f]{32}$/.test(credential)) throw new Error('Credencial individual inválida.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('El almacenamiento seguro no está disponible.')
    const next = { ...this.data, [hostId]: { target, encrypted: safeStorage.encryptString(credential).toString('base64') } }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
    this.data = next
  }
}
