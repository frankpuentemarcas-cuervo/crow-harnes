import { app, safeStorage } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { dirname, join } from 'node:path'

interface CachedSecret { identity: string; encrypted: string }
interface VaultFile { bootId: string; secrets: Record<string, CachedSecret> }

function bootId(): string {
  try {
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTimeUtc()'], { windowsHide: true, timeout: 8000 }).toString().trim()
    if (/^\d{12,}$/.test(result)) return `cim:${result}`
  } catch { /* Fail closed on the next app launch if the boot source changes. */ }
  // The fallback still invalidates on restart, with uptime's one-second resolution.
  return `uptime:${Math.round((Date.now() - uptime() * 1000) / 5000)}`
}

export class PassphraseVault {
  private path = join(app.getPath('userData'), 'ssh-passphrases.json')
  private data: VaultFile = { bootId: bootId(), secrets: {} }

  constructor() {
    try {
      if (existsSync(this.path)) {
        const saved = JSON.parse(readFileSync(this.path, 'utf8')) as VaultFile
        if (saved.bootId === this.data.bootId && saved.secrets) {
          this.data = saved
        } else {
          this.write() // Invalidate all cached secrets after a reboot.
        }
      }
    } catch {
      this.write()
    }
  }

  get(hostId: string, identity: string): string | undefined {
    const item = this.data.secrets[hostId]
    if (!item || item.identity !== identity || !safeStorage.isEncryptionAvailable()) return
    try { return safeStorage.decryptString(Buffer.from(item.encrypted, 'base64')) }
    catch { this.forget(hostId); return }
  }

  set(hostId: string, identity: string, passphrase: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('No está disponible el almacenamiento seguro de Windows.')
    this.data.secrets[hostId] = { identity, encrypted: safeStorage.encryptString(passphrase).toString('base64') }
    this.write()
  }

  forget(hostId: string): void {
    if (this.data.secrets[hostId]) {
      delete this.data.secrets[hostId]
      this.write()
    }
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
