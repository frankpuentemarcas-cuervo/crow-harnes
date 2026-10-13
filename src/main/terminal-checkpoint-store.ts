import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import type { TerminalCheckpoint, TerminalCheckpointLoadResult, TerminalCheckpointSaveResult } from '../shared/types'

interface SecureStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
const maxCheckpointBytes = 8_000_000
const maxUncompressedCheckpointBytes = 32_000_000
const compressedPrefix = 'CROWCHK1:'
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
  load(hostId: string, sessionId: string): TerminalCheckpointLoadResult {
    const path = this.path(hostId, sessionId)
    if (!existsSync(path)) return { status: 'missing' }
    try {
      if (statSync(path).size > maxCheckpointBytes) return { status: 'oversized' }
      if (!this.secure.isEncryptionAvailable()) return { status: 'unavailable' }
      const decrypted = this.secure.decryptString(readFileSync(path))
      const serialized = decrypted.startsWith(compressedPrefix)
        ? inflateSync(Buffer.from(decrypted.slice(compressedPrefix.length), 'base64'), { maxOutputLength: maxUncompressedCheckpointBytes }).toString('utf8')
        : decrypted // v0.1.34 and earlier stored encrypted JSON directly.
      if (Buffer.byteLength(serialized) > maxUncompressedCheckpointBytes) return { status: 'oversized' }
      const value = JSON.parse(serialized)
      if (!value || !Number.isSafeInteger(value.seq) || value.seq < 0 || typeof value.state !== 'string' || (value.viewportY !== undefined && (!Number.isSafeInteger(value.viewportY) || value.viewportY < 0))) return { status: 'invalid' }
      return { status: 'restored', checkpoint: { seq: value.seq, state: value.state, ...(value.viewportY !== undefined ? { viewportY: value.viewportY } : {}) } }
    } catch (error) {
      if (error instanceof Error && /output length|larger than|buffer too large/i.test(error.message)) return { status: 'oversized' }
      return { status: 'invalid' }
    }
  }
  save(hostId: string, sessionId: string, checkpoint: TerminalCheckpoint): TerminalCheckpointSaveResult {
    if (!checkpoint || !Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 0 || typeof checkpoint.state !== 'string' || (checkpoint.viewportY !== undefined && (!Number.isSafeInteger(checkpoint.viewportY) || checkpoint.viewportY < 0))) return 'invalid'
    const serialized = JSON.stringify(checkpoint)
    if (Buffer.byteLength(serialized) > maxUncompressedCheckpointBytes) return 'oversized'
    if (!this.secure.isEncryptionAvailable()) return 'unavailable'
    const compressed = deflateSync(Buffer.from(serialized, 'utf8'))
    if (compressed.byteLength > maxCheckpointBytes || compressedPrefix.length + Math.ceil(compressed.byteLength / 3) * 4 > maxCheckpointBytes) return 'oversized'
    const encrypted = this.secure.encryptString(compressedPrefix + compressed.toString('base64'))
    if (encrypted.byteLength > maxCheckpointBytes) return 'oversized'
    mkdirSync(this.directory, { recursive: true })
    const path = this.path(hostId, sessionId), temp = `${path}.tmp`
    try { writeFileSync(temp, encrypted, { mode: 0o600 }); renameSync(temp, path); return 'saved' }
    finally { rmSync(temp, { force: true }) }
  }
  remove(hostId: string, sessionId: string): void { rmSync(this.path(hostId, sessionId), { force: true }) }
}
