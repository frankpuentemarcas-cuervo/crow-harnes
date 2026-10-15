import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, posix } from 'node:path'
import type { DeviceRecord } from './mobile-device-auth'
import { devicePublicKey } from './mobile-device-auth'

export interface MobileTrustSnapshot { version: 1 | 2; gatewayId: string; lanAddress: string; lanPort: number; hostEpochs: Record<string, number>; records: DeviceRecord[]; relayRoute?: string; relayLocalPort?: number; relayUrl?: string }
export interface MobileTrustPersistence { load(): MobileTrustSnapshot | undefined; save(value: MobileTrustSnapshot): void }
interface SecureStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
const recovery = 'El almacén de vínculos móviles no está disponible o está dañado. El acceso está bloqueado. Restaurá mobile-trust.enc desde una copia segura o retiralo explícitamente para volver a vincular los dispositivos.'
const text = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
const root = (value: unknown): value is string => text(value, 4096) && value.startsWith('/') && posix.normalize(value) === value
const strings = (value: unknown, max: number, valid = text): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => valid(item)) && new Set(value).size === value.length

/** Validate the entire schema before restoring any grant. There is no permissive legacy migration. */
export function validateMobileTrust(value: unknown): asserts value is MobileTrustSnapshot {
  const routeValid = value && object(value) && (value.relayRoute === undefined || /^[A-Za-z0-9_-]{43}$/.test(String(value.relayRoute)) && Buffer.from(String(value.relayRoute), 'base64url').length === 32 && Buffer.from(String(value.relayRoute), 'base64url').toString('base64url') === value.relayRoute)
  const relayUrlValid = value && object(value) && (value.relayUrl === undefined || typeof value.relayUrl === 'string' && value.relayUrl.length <= 2048 && /^wss:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/v1\/tunnel$/.test(value.relayUrl) && !/[\x00-\x20]/.test(value.relayUrl) && (() => { try { const url = new URL(value.relayUrl); return url.protocol === 'wss:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/v1/tunnel' && (!url.port || Number(url.port) <= 65535) } catch { return false } })())
  if (!object(value) || !keys(value, ['version', 'gatewayId', 'lanAddress', 'lanPort', 'hostEpochs', 'records', 'relayRoute', 'relayLocalPort', 'relayUrl']) || !routeValid || !relayUrlValid || (value.relayLocalPort !== undefined && (!Number.isInteger(value.relayLocalPort) || Number(value.relayLocalPort) < 0 || Number(value.relayLocalPort) > 65535)) || (value.version !== 1 && value.version !== 2) || !text(value.gatewayId) || typeof value.lanAddress !== 'string' || !Number.isInteger(value.lanPort) || Number(value.lanPort) < 0 || Number(value.lanPort) > 65535 || (value.lanAddress === '' ? value.lanPort !== 0 : !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.lanAddress) || value.lanAddress.split('.').some(part => Number(part) > 255) || value.lanPort === 0) || !object(value.hostEpochs) || Object.keys(value.hostEpochs).length > 1024 || Object.entries(value.hostEpochs).some(([id, epoch]) => !text(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !Number.isSafeInteger(epoch) || Number(epoch) < 0) || !Array.isArray(value.records) || value.records.length > 16) throw new Error(recovery)
  const ids = new Set<string>(), hashes = new Set<string>()
  for (const record of value.records) {
    if (!object(record) || !keys(record, ['device', 'scopes', 'tokenHash', 'publicKey']) || !object(record.device) || !Array.isArray(record.scopes) || record.scopes.length > 64) throw new Error(recovery)
    const keyBased = record.publicKey !== undefined
    if (keyBased) { if (value.version !== 2 || record.tokenHash !== '' || record.device.expiresAt !== null) throw new Error(recovery); devicePublicKey(record.publicKey) }
    else if (typeof record.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.tokenHash) || hashes.has(record.tokenHash)) throw new Error(recovery)
    const device = record.device
    const projectIds = device.projectIds, capabilities = device.capabilities, unavailableProjects: unknown = device.unavailableProjects === undefined ? [] : device.unavailableProjects
    if (!keys(device, ['id', 'label', 'pairedAt', 'expiresAt', 'projectIds', 'unavailableProjects', 'capabilities']) || !text(device.id) || ids.has(device.id) || !text(device.label, 80) || typeof device.pairedAt !== 'string' || !Number.isFinite(Date.parse(device.pairedAt)) || (!keyBased && (typeof device.expiresAt !== 'string' || !Number.isFinite(Date.parse(device.expiresAt)) || Date.parse(device.expiresAt) <= Date.parse(device.pairedAt))) || !strings(projectIds, 64) || !Array.isArray(unavailableProjects) || unavailableProjects.length > 64 || projectIds.length + unavailableProjects.length < 1 || projectIds.length + unavailableProjects.length > 64 || !object(capabilities) || !keys(capabilities, ['input', 'create', 'close', 'quotas']) || ['input', 'create', 'close', 'quotas'].some(key => typeof capabilities[key] !== 'boolean')) throw new Error(recovery)
    const projects: string[] = []
    for (const scope of record.scopes) {
      if (!object(scope) || !keys(scope, ['projectId', 'hostId', 'root', 'hostDigest', 'binding']) || !text(scope.projectId) || !text(scope.hostId) || !root(scope.root) || typeof scope.hostDigest !== 'string' || !/^[0-9a-f]{64}$/.test(scope.hostDigest) || !object(scope.binding)) throw new Error(recovery)
      const binding = scope.binding
      const validRole = binding.role === 'admin' || binding.role === 'member' || binding.role === 'installation'
      if (!keys(binding, ['actorId', 'generation', 'allowedRoots', 'operateOthers', 'role']) || !text(binding.actorId) || !text(binding.generation, 4096) || typeof binding.operateOthers !== 'boolean' || ((binding.role !== undefined || keyBased) && !validRole) || !strings(binding.allowedRoots, 1024, root) || !binding.allowedRoots.includes(scope.root)) throw new Error(recovery)
      projects.push(scope.projectId)
    }
    const unavailableIds: string[] = []
    for (const project of unavailableProjects) {
      if (!object(project) || !keys(project, ['id', 'hostId', 'name', 'availability']) || !text(project.id) || !text(project.hostId) || !text(project.name, 256) || (project.availability !== 'server-disconnected' && project.availability !== 'authorization-required')) throw new Error(recovery)
      unavailableIds.push(project.id)
    }
    if (new Set(projects).size !== projects.length || projects.length !== projectIds.length || projects.some(id => !projectIds.includes(id)) || new Set(unavailableIds).size !== unavailableIds.length || unavailableIds.some(id => projectIds.includes(id))) throw new Error(recovery)
    ids.add(device.id); if (!keyBased) hashes.add(record.tokenHash as string)
  }
}

/** Encrypt the complete metadata/grant envelope with Electron safeStorage (Windows DPAPI). */
export class MobileTrustStore implements MobileTrustPersistence {
  constructor(private path: string, private secure: SecureStorage) {}
  load(): MobileTrustSnapshot | undefined {
    try {
      if (!this.secure.isEncryptionAvailable()) throw new Error(recovery)
      if (!existsSync(this.path)) return
      if (statSync(this.path).size > 1024 * 1024) throw new Error(recovery)
      const value: unknown = JSON.parse(this.secure.decryptString(readFileSync(this.path)))
      validateMobileTrust(value)
      if (value.version === 1) {
        const migrated: MobileTrustSnapshot = { ...value, version: 2 }
        this.save(migrated) // Explicit envelope-only migration; legacy expirations/grants are never extended.
        return migrated
      }
      return value
    } catch { throw new Error(recovery) }
  }
  save(value: MobileTrustSnapshot): void {
    let temporary = ''
    try {
      validateMobileTrust(value)
      if (value.version !== 2) throw new Error(recovery)
      if (!this.secure.isEncryptionAvailable()) throw new Error(recovery)
      const raw = JSON.stringify(value)
      if (Buffer.byteLength(raw) > 512 * 1024) throw new Error(recovery)
      const encrypted = this.secure.encryptString(raw)
      mkdirSync(dirname(this.path), { recursive: true })
      temporary = `${this.path}.${randomUUID()}.tmp`
      writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx', flush: true })
      renameSync(temporary, this.path)
    } catch { throw new Error(recovery) }
    finally { if (temporary && existsSync(temporary)) rmSync(temporary, { force: true }) }
  }
}
