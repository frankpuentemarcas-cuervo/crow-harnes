import type { ConnectionStatus, SessionInfo } from './types'

export type MobileRemoteProvider = 'tailscale' | 'pangolin'
export interface MobileStartInput { address: string; publicOrigin?: string; remoteProvider?: MobileRemoteProvider; loopbackPort?: number; relayUrl?: string }
export interface MobileEndpoint { kind: 'lan-pinned' | 'remote-public' | 'relay'; url: string; certSHA256?: string; provider?: 'pangolin'; proxyAuthRequired?: true; relayUrl?: string; relayRoute?: string }
export interface MobileCapabilities { input: boolean; create: boolean; close: boolean; quotas: boolean }
export type MobileErrorCode = 'INVALID_ORIGIN' | 'GATEWAY_UNAVAILABLE' | 'HOST_UNAVAILABLE' | 'DEVICE_REJECTED' | 'GRANT_REQUIRED' | 'RATE_LIMITED' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'REQUEST_CONFLICT'
export interface MobileErrorEnvelope { code: MobileErrorCode; error: string }
/** Gateway implementation support, independent from each device's authorization grants. */
export interface MobileSupportedFeatures {
  sessionList: boolean
  terminalStream: boolean
  terminalInput: boolean
  sessionCreate: boolean
  sessionWake: boolean
  sessionClose: boolean
  notices: boolean
  quotas: boolean
  pushNotifications: boolean
  structuredChat: boolean
  approvalActions: boolean
  fileBrowser: boolean
  gitStatus: boolean
}
export const MOBILE_SUPPORTED_FEATURES: MobileSupportedFeatures = {
  sessionList: true,
  terminalStream: true,
  terminalInput: true,
  sessionCreate: true,
  sessionWake: true,
  sessionClose: true,
  notices: true,
  quotas: true,
  pushNotifications: false,
  structuredChat: false,
  approvalActions: false,
  fileBrowser: false,
  gitStatus: false,
}
export interface MobilePangolinAuth { tokenId: string; token: string }
export interface MobileEnrollmentInput { projectIds: string[]; capabilities?: Partial<MobileCapabilities>; pangolinAuth?: MobilePangolinAuth }
/** Metadata retained by the gateway; deliberately excludes any reusable Pangolin credential. */
export interface MobileEnrollmentMetadata { version: 1 | 2; gatewayId: string; invitationCode: string; expiresAt: string; endpoints: MobileEndpoint[] }
/** Credential-bearing QR payload only; never persist, log, or return this value from gateway status. */
export interface MobileEnrollment extends Omit<MobileEnrollmentMetadata, 'endpoints'> { endpoints: (MobileEndpoint & { proxyAuth?: { origin: string } & MobilePangolinAuth })[] }
/** Renderer receives only a safe summary and the QR bitmap, never the credential-bearing QR text. */
export interface MobileInviteResult { enrollment: MobileEnrollmentMetadata; qrDataUrl: string }
/** null means key-based trust until explicit revocation, never a permanent bearer. */
export interface MobileDevice { id: string; label: string; pairedAt: string; expiresAt: string | null; projectIds: string[]; unavailableProjects?: MobileProject[]; capabilities: MobileCapabilities }
/** generation includes host target + current credential/access epoch, never raw credentials. */
export interface MobileActorBinding { actorId: string; generation: string; allowedRoots: string[]; operateOthers: boolean; role?: 'admin' | 'member' }
export interface MobilePairResult { version: 1 | 2; device: MobileDevice; credential: string; credentialExpiresAt?: string; endpoints: MobileEndpoint[] }
export interface MobileDeviceChallenge { version: 2; gatewayId: string; deviceId: string; challengeId: string; nonce: string; expiresAt: string }
export type MobileProjectAvailability = 'available' | 'server-disconnected' | 'authorization-required'
export interface MobileProject { id: string; hostId: string; name: string; availability?: MobileProjectAvailability }
export interface MobileHost { id: string; name: string; status: ConnectionStatus }
export interface MobileSession extends Omit<SessionInfo, 'root' | 'promptCache'> { projectId: string; name?: string; canOperate: boolean }
export interface MobileNotice { id: string; hostId: string; sessionId: string; kind: 'turn-complete' | 'process-exited'; at: string; requiresAttention?: boolean }
export interface MobileQuota { id: string; label: string; provider: 'claude' | 'codex'; state: string; windows: { label: string; usedPercent: number | null; resetsAt: string | null }[]; sampledAt: string | null }
export interface MobileBootstrap { version: 1; device: MobileDevice; hosts: MobileHost[]; projects: MobileProject[]; actor: { label: string }; devices: MobileDevice[]; supportedFeatures?: MobileSupportedFeatures }

/** Native API: POST pair {invitationCode,deviceName}; Bearer required thereafter.
 * GET bootstrap; GET sessions?hostId=&projectId=; POST sessions {hostId,projectId,agent:'claude'|'codex'};
 * POST wake/close {hostId,sessionId}; POST input {streamId,data:base64}; POST resize {streamId,cols,rows};
 * GET notices; GET quotas; WSS stream?hostId=&sessionId=&from= (Authorization header, never query token).
 * Key-based v2 mutations require a UUID requestId in the JSON body (also input/resize WS frames).
 * Deduplication is scoped to the authenticated short-credential context, retained through expiry + skew,
 * not durable exactly-once across restart. Unknown outcomes are tombstoned, never automatically retried.
 * V2 WS output stays live with valid device trust; WS writes require the upgrade context still active.
 * Android writes through HTTP with a freshly renewed bearer when needed. Legacy v1 remains unchanged.
 * Input/resize are never automatically retried. Streams emit existing output/state frames and ready {streamId}.
 */
export const MOBILE_API_VERSION = 1
