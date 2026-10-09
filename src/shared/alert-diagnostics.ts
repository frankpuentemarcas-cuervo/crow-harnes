import type { AttentionClassification } from './types'

export const auditReasons = {
  approval: 'Pide autorización.', choice: 'Pide una decisión.', missing_information: 'Necesita datos del usuario.', blocked: 'Está bloqueado esperando al usuario.',
  progress: 'Informa progreso.', background_work: 'Hay trabajo en segundo plano.', completed_no_action: 'Terminó sin pedir intervención.', quoted_or_resolved: 'La petición está citada o ya resuelta.',
  insufficient_context: 'Falta contexto.', not_reported: 'El modelo no informó un motivo válido.'
} as const
export type AuditReason = keyof typeof auditReasons
export type NoticeSoundOutcome = 'eligible' | 'pending' | 'informational' | 'already-read' | 'duplicate' | 'restored' | 'stale' | 'scheduled' | 'playback-ended' | 'playback-error'
export const classifierStages = ['configuration', 'input', 'request', 'http', 'response_body', 'envelope', 'content', 'model_json', 'decision'] as const
export const classifierErrorCodes = ['invalid_url', 'empty_input', 'input_too_large', 'transport_error', 'http_error', 'missing_body', 'response_too_large', 'body_read_error', 'invalid_envelope_json', 'missing_content', 'invalid_content_type', 'invalid_model_json', 'invalid_decision'] as const
export const finishReasons = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'] as const
export const transportCauses = ['timeout', 'cancelled', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'unknown'] as const
export interface ClassifierDiagnostic {
  httpStatus?: number; reportedModel?: string; reasonCode?: AuditReason; explanation?: string
  stage?: typeof classifierStages[number]; errorCode?: typeof classifierErrorCodes[number]
  finishReason?: typeof finishReasons[number]; transportCause?: typeof transportCauses[number]
  responseBytes?: number; contentChars?: number
}
export interface AlertAuditRecord extends ClassifierDiagnostic {
  id: string; hostId: string; sessionId: string; eventId: string; eventAt: string; receivedAt: string
  input: string; inputChars: number; inputTruncated: boolean; inputRedacted?: boolean; requestedModel: string; promptVersion: string
  classification?: AttentionClassification
  queueMs?: number; inferenceMs?: number; finishedAt?: string; noticeEmitted?: boolean
  sound: { at: string; outcome: NoticeSoundOutcome }[]
}
export type AlertAuditSummary = Omit<AlertAuditRecord, 'input' | 'explanation'>
export interface AlertAuditStatus { enabled: boolean; secureStorageAvailable: boolean; count: number; retentionDays: number; error?: string }
export interface AuditRef { id: string; generation: number }
export interface AttentionAudit {
  begin(hostId: string, event: { id: string; sessionId: string; at: string; message?: string; messageTruncated?: boolean }, model: string): AuditRef | undefined
  update(ref: AuditRef | undefined, patch: ClassifierDiagnostic & Partial<Pick<AlertAuditRecord, 'classification' | 'queueMs' | 'inferenceMs' | 'finishedAt' | 'noticeEmitted'>>): void
}
