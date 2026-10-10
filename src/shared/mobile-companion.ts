import type { ConnectionStatus, SessionInfo } from './types'

export interface MobileStartInput { address: string; publicOrigin?: string }
export interface MobileEndpoint { kind: 'lan-pinned' | 'remote-public'; url: string; certSHA256?: string }
export interface MobileCapabilities { input: boolean; create: boolean; close: boolean; quotas: boolean }
export interface MobileEnrollmentInput { projectIds: string[]; capabilities?: Partial<MobileCapabilities> }
/** No reusable credential in this desktop-only, single-use invitation. */
export interface MobileEnrollment { version: 1; gatewayId: string; invitationCode: string; expiresAt: string; endpoints: MobileEndpoint[] }
export interface MobileDevice { id: string; label: string; pairedAt: string; expiresAt: string; projectIds: string[]; capabilities: MobileCapabilities }
/** generation includes host target + current credential/access epoch, never raw credentials. */
export interface MobileActorBinding { actorId: string; generation: string; allowedRoots: string[]; operateOthers: boolean }
export interface MobilePairResult { version: 1; device: MobileDevice; credential: string; endpoints: MobileEndpoint[] }
export interface MobileProject { id: string; hostId: string; name: string }
export interface MobileHost { id: string; name: string; status: ConnectionStatus }
export interface MobileSession extends Omit<SessionInfo, 'root' | 'promptCache'> { projectId: string; name?: string; canOperate: boolean }
export interface MobileNotice { id: string; hostId: string; sessionId: string; kind: 'turn-complete' | 'process-exited'; at: string; requiresAttention?: boolean }
export interface MobileQuota { id: string; label: string; provider: 'claude' | 'codex'; state: string; windows: { label: string; usedPercent: number | null; resetsAt: string | null }[]; sampledAt: string | null }
export interface MobileBootstrap { version: 1; device: MobileDevice; hosts: MobileHost[]; projects: MobileProject[]; actor: { label: string }; devices: MobileDevice[] }

/** Native API: POST pair {invitationCode,deviceName}; Bearer required thereafter.
 * GET bootstrap; GET sessions?hostId=&projectId=; POST sessions {hostId,projectId,agent:'claude'|'codex'};
 * POST wake/close {hostId,sessionId}; POST input {streamId,data:base64}; POST resize {streamId,cols,rows};
 * GET notices; GET quotas; WSS stream?hostId=&sessionId=&from= (Authorization header, never query token).
 * Input/resize are never automatically retried. Streams emit existing output/state frames and ready {streamId}.
 */
export const MOBILE_API_VERSION = 1
