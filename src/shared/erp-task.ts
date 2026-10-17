export type ERPTaskStage = 'review' | 'ready' | 'running' | 'human-review' | 'done'
export interface ERPConnectionInput { url: string; apiKey?: string; apiSecret?: string; allowAIClassification: boolean; allowProjectContext?: boolean }
export interface ERPConnection { url: string; configured: boolean; allowAIClassification: boolean; allowProjectContext: boolean; identity?: string; error?: string }
export interface ERPProjectCandidate { id: string; name: string; hostId: string; hostConnected?: boolean; summary?: string; tags?: string[]; repository?: string; repositoryReadable?: boolean }
export interface ERPExistingTerminalInput { hostId: string; sessionId: string }
export interface ERPTerminalCatalogue { terminals: ERPTerminalCandidate[]; warnings: string[] }
export interface ERPTerminalTarget { projectId: string; hostId: string; sessionId: string }
export interface ERPTerminalCandidate extends ERPTerminalTarget { name: string; agent: 'shell' | 'claude' | 'codex' | 'agy' | 'unknown'; canSubmit?: boolean; projectName?: string; hostName?: string }
export interface ERPDispatchTarget extends ERPTerminalCandidate { actorId: string; root: string }
export interface ERPTaskCard {
  key: string; name: string; subject: string; description: string; descriptionLoaded?: boolean; erpProject: string; erpStatus: string; priority: string; modified: string; assignedTo?: string[]
  stage: ERPTaskStage; projectId?: string; hostId?: string; sessionName?: string; dispatchTarget?: ERPDispatchTarget; submissionStatus?: string; reason?: string; stale: boolean; metadataUnavailable?: boolean; sessionId?: string; jobId?: string; dispatchStatus?: 'pending' | 'delivered' | 'uncertain'; error?: string
}
export interface ERPTaskSnapshot { refreshing?: boolean; connection: ERPConnection; tasks: ERPTaskCard[]; links: Record<string, string> }
export interface ERPDispatchJob { jobId: string; taskKey: string; hostId: string; projectId: string; root: string; actorId: string; agent: 'claude' | 'codex'; initialPrompt: string; sessionId?: string; sessionName?: string }
export interface ERPTaskPreviewInput { taskKey: string; projectId: string; hostId: string; agent: 'claude' | 'codex'; sessionId?: string }
export interface ERPTaskPreview extends ERPDispatchJob { previewId: string; expiresAt: number }
