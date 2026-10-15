import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, type KeyObject } from 'node:crypto'
import type { MobileActorBinding, MobileCapabilities, MobileDevice, MobileDeviceChallenge, MobileEnrollmentMetadata, MobileProject } from '../shared/mobile-companion'
import type { MobileMutationContext } from './mobile-mutation-ledger'

export const INVITATION_TTL = 5 * 60_000
export const DEVICE_TTL = 12 * 60 * 60_000
export const ACCESS_TTL = 15 * 60_000
export const CHALLENGE_TTL = 30_000
export const READ_CAPABILITIES: MobileCapabilities = { input: false, create: false, close: false, quotas: false }
/** Unavailable authorization is not proof of revocation; access remains suspended. */
export class MobileHostUnavailableError extends Error {}
export class MobileAuthorizationChangedError extends Error {}
export interface MobileScope { projectId: string; hostId: string; root: string; hostDigest: string; binding: MobileActorBinding }
export interface DeviceRecord { device: MobileDevice; scopes: MobileScope[]; tokenHash: string; publicKey?: string }
interface Invitation { value: MobileEnrollmentMetadata; scopes: MobileScope[]; unavailableProjects: MobileProject[]; capabilities: MobileCapabilities; codeHash: string }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function matches(value: string, hash: string): boolean {
  const candidate = Buffer.from(digest(value), 'hex')
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}
/** Standard SPKI P-256 only; canonical re-export rejects trailing DER and alternate encodings. */
export function devicePublicKey(value: unknown): KeyObject {
  if (typeof value !== 'string' || value.length !== 124) throw new Error('Clave de dispositivo inválida.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== 91 || bytes.toString('base64') !== value) throw new Error('Clave de dispositivo inválida.')
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || !key.export({ format: 'der', type: 'spki' }).equals(bytes)) throw new Error('Clave de dispositivo inválida.')
  return key
}
export function deviceProofPayload(challenge: MobileDeviceChallenge): Buffer {
  return Buffer.from(`crow-mobile-renew:v2\n${challenge.gatewayId}\n${challenge.deviceId}\n${challenge.challengeId}\n${challenge.nonce}`, 'utf8')
}

/** Only SHA256 hashes are retained, never plaintext bearer tokens. Invitations remain ephemeral. */
export class MobileDeviceRegistry {
  private pending?: Invitation
  private records = new Map<string, DeviceRecord>()
  private attempts = new Map<string, { count: number; until: number }>()
  private total = { count: 0, until: 0 }
  private persistenceFailed = false
  private challenges = new Map<string, MobileDeviceChallenge>()
  private access = new Map<string, MobileMutationContext>()
  private challengeAttempts = new Map<string, { count: number; until: number }>()
  constructor(private now: () => number = Date.now, initial: DeviceRecord[] = [], private persist?: (records: DeviceRecord[]) => void) {
    for (const record of structuredClone(initial)) if (record.publicKey && record.device.expiresAt === null || record.device.expiresAt !== null && Date.parse(record.device.expiresAt) > this.now()) this.records.set(record.device.id, record)
  }
  snapshot(): DeviceRecord[] { this.assertAvailable(); return structuredClone([...this.records.values()].filter(record => this.active(record))) }
  private assertAvailable(): void { if (this.persistenceFailed) throw new MobileHostUnavailableError('No se pudo guardar el vínculo. El acceso está bloqueado hasta reparar el almacenamiento seguro.') }
  private commit(next: Map<string, DeviceRecord>): void {
    this.assertAvailable()
    try { this.persist?.(structuredClone([...next.values()])); this.records = next }
    catch (error) { this.persistenceFailed = true; throw error }
  }

  invite(value: Omit<MobileEnrollmentMetadata, 'invitationCode' | 'expiresAt'>, scopes: MobileScope[], capabilities: MobileCapabilities, unavailableProjects: MobileProject[] = []): MobileEnrollmentMetadata {
    this.assertAvailable()
    for (const record of this.records.values()) if (!this.active(record)) this.records.delete(record.device.id)
    if ((!scopes.length && !unavailableProjects.length) || this.records.size >= 16) throw new Error('Seleccioná al menos un proyecto (máximo 16 dispositivos).')
    const invitationCode = randomBytes(6).toString('hex').toUpperCase()
    const enrollment: MobileEnrollmentMetadata = { ...value, invitationCode, expiresAt: new Date(this.now() + INVITATION_TTL).toISOString() }
    this.pending = { value: enrollment, scopes: structuredClone(scopes), unavailableProjects: structuredClone(unavailableProjects), capabilities: { ...capabilities }, codeHash: digest(invitationCode) }
    return enrollment
  }
  invitation(): MobileEnrollmentMetadata | undefined {
    if (this.pending && Date.parse(this.pending.value.expiresAt) <= this.now()) this.pending = undefined
    return this.pending?.value
  }
  candidate(code: string, ip: string): MobileScope[] {
    this.assertAvailable()
    const now = this.now()
    if (this.total.until <= now) this.total = { count: 0, until: now + 60_000 }
    const attempt = this.attempts.get(ip)
    if (++this.total.count > 60 || (attempt && attempt.until > now && attempt.count >= 5)) throw new Error('RATE_LIMIT')
    const pending = this.invitation() && this.pending
    if (!pending || !matches(code, pending.codeHash)) {
      if (this.attempts.size >= 256 && !this.attempts.has(ip)) this.attempts.delete(this.attempts.keys().next().value!)
      this.attempts.set(ip, { count: attempt && attempt.until > now ? attempt.count + 1 : 1, until: now + 10 * 60_000 })
      throw new Error('Código inválido o vencido.')
    }
    return structuredClone(pending.scopes)
  }
  pair(code: string, label: string): { record: DeviceRecord; credential: string } {
    this.assertAvailable()
    const pending = this.invitation() && this.pending
    if (!pending || pending.value.version !== 1 || !matches(code, pending.codeHash)) throw new Error('Código inválido o vencido. Esta invitación requiere Android compatible con claves de dispositivo.')
    if (!label.trim() || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Nombre de dispositivo inválido.')
    this.pending = undefined // Consume synchronously only after all asynchronous actor checks.
    const credential = randomBytes(32).toString('hex')
    const device: MobileDevice = { id: randomUUID(), label: label.trim(), pairedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + DEVICE_TTL).toISOString(), projectIds: pending.scopes.map(scope => scope.projectId), ...(pending.unavailableProjects.length ? { unavailableProjects: pending.unavailableProjects } : {}), capabilities: pending.capabilities }
    const record = { device, scopes: pending.scopes, tokenHash: digest(credential) }
    this.commit(new Map(this.records).set(device.id, record))
    return { record, credential }
  }
  pairKey(code: string, label: string, publicKey: string): { record: DeviceRecord; credential: string; credentialExpiresAt: string } {
    this.assertAvailable()
    const pending = this.invitation() && this.pending
    if (!pending || pending.value.version !== 2 || !matches(code, pending.codeHash)) throw new Error('Invitación incompatible, inválida o vencida.')
    if (!label.trim() || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Nombre de dispositivo inválido.')
    devicePublicKey(publicKey)
    if (pending.scopes.some(scope => !['admin', 'member', 'installation'].includes(scope.binding.role || ''))) throw new Error('La autorización requiere una identidad Crow vigente.')
    if ([...this.records.values()].some(record => record.publicKey === publicKey)) throw new Error('La clave ya está vinculada. Usá una clave nueva para una nueva invitación.')
    this.pending = undefined
    const device: MobileDevice = { id: randomUUID(), label: label.trim(), pairedAt: new Date(this.now()).toISOString(), expiresAt: null, projectIds: pending.scopes.map(scope => scope.projectId), ...(pending.unavailableProjects.length ? { unavailableProjects: pending.unavailableProjects } : {}), capabilities: pending.capabilities }
    const record: DeviceRecord = { device, scopes: pending.scopes, tokenHash: '', publicKey }
    this.commit(new Map(this.records).set(device.id, record))
    return { record, ...this.issueCredential(record) }
  }
  keyDevice(id: string): DeviceRecord {
    this.assertAvailable()
    const record = this.records.get(id)
    if (!record?.publicKey || !this.active(record)) throw new Error('Dispositivo no autorizado.')
    return record
  }
  challenge(id: string, gatewayId: string, ip: string): MobileDeviceChallenge {
    this.keyDevice(id)
    const now = this.now()
    for (const [key, value] of this.challenges) if (Date.parse(value.expiresAt) <= now) this.challenges.delete(key)
    for (const [key, value] of this.challengeAttempts) if (value.until <= now) this.challengeAttempts.delete(key)
    if (this.challengeAttempts.size >= 256 && !this.challengeAttempts.has(ip)) throw new Error('RATE_LIMIT')
    const attempt = this.challengeAttempts.get(ip) || { count: 0, until: now + 60_000 }
    if (++attempt.count > 10 || this.challenges.size >= 64) throw new Error('RATE_LIMIT')
    this.challengeAttempts.set(ip, attempt)
    const value: MobileDeviceChallenge = { version: 2, gatewayId, deviceId: id, challengeId: randomUUID(), nonce: randomBytes(32).toString('hex'), expiresAt: new Date(now + CHALLENGE_TTL).toISOString() }
    this.challenges.set(value.challengeId, value)
    return structuredClone(value)
  }
  prove(id: string, challengeId: string, signature: string): DeviceRecord {
    this.assertAvailable()
    const challenge = this.challenges.get(challengeId)
    this.challenges.delete(challengeId) // Consume before verification and asynchronous authorization, including invalid proofs.
    const record = this.keyDevice(id)
    if (!challenge || challenge.deviceId !== id || Date.parse(challenge.expiresAt) <= this.now() || typeof signature !== 'string' || signature.length > 112) throw new Error('Prueba inválida o vencida.')
    const bytes = Buffer.from(signature, 'base64')
    if (bytes.length < 8 || bytes.length > 80 || bytes.toString('base64') !== signature || !verify('sha256', deviceProofPayload(challenge), devicePublicKey(record.publicKey), bytes)) throw new Error('Prueba inválida o vencida.')
    return record
  }
  issueCredential(record: DeviceRecord): { credential: string; credentialExpiresAt: string } {
    if (!record.publicKey || !this.active(record)) throw new Error('Dispositivo revocado.')
    const now = this.now(), credential = randomBytes(32).toString('hex'), expiresAt = now + ACCESS_TTL
    for (const [hash, value] of this.access) if (value.expiresAt <= now || value.deviceId === record.device.id) this.access.delete(hash)
    this.access.set(digest(credential), { id: randomUUID(), deviceId: record.device.id, expiresAt })
    return { credential, credentialExpiresAt: new Date(expiresAt).toISOString() }
  }
  credentialContext(credential: string): MobileMutationContext | undefined {
    if (!this.authenticate(credential)) return
    return this.access.get(digest(credential))
  }
  contextActive(context: MobileMutationContext, record: DeviceRecord): boolean {
    return this.active(record) && context.deviceId === record.device.id && context.expiresAt > this.now() && [...this.access.values()].some(value => value === context)
  }
  credentialExpiry(credential: string): number | undefined {
    const access = this.access.get(digest(credential))
    if (access) return access.expiresAt
    const record = this.authenticate(credential)
    return record?.device.expiresAt ? Date.parse(record.device.expiresAt) : undefined
  }
  cancelAccess(hostId?: string): void {
    const affected = (id: string): boolean => !hostId || !!this.records.get(id)?.scopes.some(scope => scope.hostId === hostId)
    for (const [id, challenge] of this.challenges) if (affected(challenge.deviceId)) this.challenges.delete(id)
    for (const [hash, value] of this.access) if (affected(value.deviceId)) this.access.delete(hash)
  }
  authenticate(credential: string): DeviceRecord | undefined {
    this.assertAvailable()
    if (!/^[0-9a-f]{64}$/.test(credential)) return undefined
    const access = this.access.get(digest(credential))
    if (access) {
      const record = this.records.get(access.deviceId)
      if (access.expiresAt > this.now() && record && this.active(record)) return record
      this.access.delete(digest(credential)); return
    }
    for (const record of this.records.values()) {
      if (record.publicKey) continue
      if (!record.device.expiresAt || Date.parse(record.device.expiresAt) <= this.now()) { this.records.delete(record.device.id); continue }
      if (matches(credential, record.tokenHash)) return record
    }
    return undefined
  }
  active(record: DeviceRecord): boolean { this.assertAvailable(); return this.records.get(record.device.id) === record && (!!record.publicKey && record.device.expiresAt === null || !!record.device.expiresAt && Date.parse(record.device.expiresAt) > this.now()) }
  list(): MobileDevice[] { return [...this.records.values()].filter(record => this.active(record)).map(record => structuredClone(record.device)) }
  revoke(id: string): void { const next = new Map(this.records); if (next.delete(id)) this.commit(next) }
  cancelInvitation(hostId?: string): void {
    if (!hostId || this.pending?.scopes.some(scope => scope.hostId === hostId)) this.pending = undefined
  }
  invalidateHost(hostId: string): string[] {
    if (this.pending?.scopes.some(scope => scope.hostId === hostId)) this.pending = undefined
    const ids = [...this.records.values()].filter(record => record.scopes.some(scope => scope.hostId === hostId)).map(record => record.device.id)
    const next = new Map(this.records); ids.forEach(id => next.delete(id)); this.commit(next)
    return ids
  }
  clear(): void { this.pending = undefined; this.commit(new Map()); this.cancelAccess(); this.attempts.clear(); this.total = { count: 0, until: 0 } }
}
