import type { AttentionClassification } from './types'

export const auditReasons = {
  approval: 'Pide autorización.', choice: 'Pide una decisión.', missing_information: 'Necesita datos del usuario.', blocked: 'Está bloqueado esperando al usuario.',
  progress: 'Informa progreso.', background_work: 'Hay trabajo en segundo plano.', completed_no_action: 'Terminó sin pedir intervención.', quoted_or_resolved: 'La petición está citada o ya resuelta.',
  insufficient_context: 'Falta contexto.', not_reported: 'El modelo no informó un motivo válido.'
} as const
export type AuditReason = keyof typeof auditReasons
export type NoticeSoundOutcome = 'eligible' | 'pending' | 'informational' | 'already-read' | 'duplicate' | 'restored' | 'stale' | 'scheduled' | 'playback-ended' | 'playback-error'
export interface ClassifierDiagnostic { httpStatus?: number; reportedModel?: string; reasonCode?: AuditReason; explanation?: string }
export interface AlertAuditRecord {
  id: string; hostId: string; sessionId: string; eventId: string; eventAt: string; receivedAt: string
  input: string; inputChars: number; inputTruncated: boolean; inputRedacted?: boolean; requestedModel: string; promptVersion: string
  classification?: AttentionClassification; reasonCode?: AuditReason; explanation?: string; reportedModel?: string; httpStatus?: number
  queueMs?: number; inferenceMs?: number; finishedAt?: string; noticeEmitted?: boolean
  sound: { at: string; outcome: NoticeSoundOutcome }[]
}
export type AlertAuditSummary = Omit<AlertAuditRecord, 'input' | 'explanation'>
export interface AlertAuditStatus { enabled: boolean; secureStorageAvailable: boolean; count: number; retentionDays: number; error?: string }
export interface AuditRef { id: string; generation: number }
export interface AttentionAudit {
  begin(hostId: string, event: { id: string; sessionId: string; at: string; message?: string; messageTruncated?: boolean }, model: string): AuditRef | undefined
  update(ref: AuditRef | undefined, patch: Partial<Pick<AlertAuditRecord, 'classification' | 'reasonCode' | 'explanation' | 'reportedModel' | 'httpStatus' | 'queueMs' | 'inferenceMs' | 'finishedAt' | 'noticeEmitted'>>): void
}
