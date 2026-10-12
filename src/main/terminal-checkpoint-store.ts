import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface SecureStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export interface TerminalCheckpoint { seq: number; state: string }
const maxCheckpointBytes = 8_000_000
const valid = (hostId: string, sessionId: string): boolean => /^[\w.-]{1,128}$/.test(hostId) && /^[0-9a-f]{32}$/.test(sessionId)

/** Encrypted local xterm snapshots let a reopened terminal resume from a cursor instead of replaying remote history. */
export class TerminalCheckpointStore {
  private readonly directory: string
  private readonly secure: SecureStorage
  constructor(directory: string, secure: SecureStorage) { this.directory = join(directory, 'terminal-checkpoints'); this.secure = secure }
  private path(hostId: string, sessionId: string): string {
    if (!valid(hostId, sessionId)) throw new Error('Terminal inválida.')
    const key = createHash('sha256').update(`${hostId}:${sessionId}`).digest('hex')
    return join(this.directory, `${key}.enc`)
  }
  load(hostId: string, sessionId: string): TerminalCheckpoint | undefined {
    const path = this.path(hostId, sessionId)
    if (!existsSync(path) || statSync(path).size > maxCheckpointBytes || !this.secure.isEncryptionAvailable()) return
    try {
      const value = JSON.parse(this.secure.decryptString(readFileSync(path)))
      if (!value || !Number.isSafeInteger(value.seq) || value.seq < 0 || typeof value.state !== 'string' || Buffer.byteLength(value.state) > maxCheckpointBytes) return
      return { seq: value.seq, state: value.state }
    } catch { return }
  }
  save(hostId: string, sessionId: string, checkpoint: TerminalCheckpoint): void {
    if (!this.secure.isEncryptionAvailable()) return
    if (!checkpoint || !Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 0 || typeof checkpoint.state !== 'string') return
    if (Buffer.byteLength(checkpoint.state) > maxCheckpointBytes) { this.remove(hostId, sessionId); return }
    mkdirSync(this.directory, { recursive: true })
    const path = this.path(hostId, sessionId), temp = `${path}.tmp`
    try { writeFileSync(temp, this.secure.encryptString(JSON.stringify(checkpoint)), { mode: 0o600 }); renameSync(temp, path) }
    finally { rmSync(temp, { force: true }) }
  }
  remove(hostId: string, sessionId: string): void { rmSync(this.path(hostId, sessionId), { force: true }) }
}
