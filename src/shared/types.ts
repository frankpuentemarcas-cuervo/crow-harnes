export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'auth-required'
import type { AlertAuditRecord, AlertAuditStatus, AlertAuditSummary, NoticeSoundOutcome } from './alert-diagnostics'
import type { FreeLLMRuntimeStatus } from './free-llm-startup'

export type Agent = 'shell' | 'claude' | 'codex' | 'agy'
export type Mode = 'normal' | 'bypass'
export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateState {
  status: UpdateStatus
  version?: string
  percent?: number
}

export interface Host {
  id: string
  name: string
  target: string
  port: number
  identity?: string
  remotePort: number
}

export interface HostMetrics {
  cpuPercent: number | null
  memoryUsed: number
  memoryTotal: number
  diskUsed: number
  diskTotal: number
  sleepingSessions: number
  sleepingMemory: number
  at: string
}

export interface MobileStatus {
  running: boolean
  url?: string
  pairingCode?: string
  fingerprint?: string
  paired?: boolean
}

export interface Project {
  id: string
  hostId: string
  name: string
  root: string
}

export interface SessionInfo {
  id: string
  agent: Agent
  mode: Mode
  root: string
  state: 'running' | 'sleeping' | 'exited' | 'interrupted'
  agentState?: 'working' | 'waiting' | 'completed' | 'unknown'
  hooksActive?: boolean
  cacheTtlSeconds?: number
  cacheExpiresAt?: string
  promptCache?: PromptCache
  startedAt: string
  updatedAt: string
  seq: number
  exitCode?: number
}

/** Main-conversation statistics reported by Claude; never prompt content. */
export interface PromptCache {
  source: 'claude-statusline'
  conversationId?: string
  reportedAt: string
  serverTime?: string
  /** Client-only anchor; never sent back to the server or persisted. */
  receivedAt?: number
  ttlSeconds?: 300 | 3600
  expiresAt?: string
  warm?: boolean
  observed?: boolean
  hitRatio?: number
  readTokens?: number
  writtenTokens?: number
  freshTokens?: number
  requests?: number
  misses?: number
  lastMissCauses?: string[]
}

export interface TerminalFrame {
  type: 'output' | 'state' | 'disconnected'
  seq?: number
  data?: string
  info?: SessionInfo
}

export interface RemoteEvent {
  id: string
  seq: number
  sessionId: string
  kind: 'turn-complete' | 'process-exited'
  requiresAttention?: boolean
  at: string
  /** Opt-in, transient text. Never persisted or forwarded to renderer/mobile. */
  message?: string
  messageTruncated?: boolean
}

export interface AttentionClassification {
  source: 'rules' | 'pending' | 'ai' | 'fallback'
  decision: 'actionable' | 'informational' | 'uncertain'
  detail: string
}

export interface Notice extends Omit<RemoteEvent, 'message' | 'messageTruncated'> {
  hostId: string
  read: boolean
  classification?: AttentionClassification
}

export interface AlertAISettings {
  enabled: boolean
  autoOpenFreeLLM?: boolean
  baseURL: string
  model: string
  keyPresent: boolean
  secureStorageAvailable: boolean
  configurationError?: string
}

export interface AlertAIInput {
  enabled: boolean
  autoOpenFreeLLM?: boolean
  baseURL: string
  model: string
  apiKey?: string
  removeKey?: boolean
}

export interface AlertAIStatus {
  state: 'idle' | 'working' | 'ok' | 'error'
  detail: string
}

export interface FileEntry {
  name: string
  path: string
  dir: boolean
  size: number
}

export interface FileContent {
  content: string
  hash: string
  size: number
}

export interface FileUploadResult {
  uploaded: string[]
  failed: { name: string; error: string }[]
  canceled: boolean
}

export interface WorkspaceTab {
  id: string
  projectId: string
  kind: 'terminal' | 'editor' | 'browser'
  sessionId?: string
  path?: string
  url?: string
}

export interface SavedState {
  hosts: Host[]
  projects: Project[]
  notices: Notice[]
  sessionNames: Record<string, string>
  eventCursors: Record<string, number>
  tabs: WorkspaceTab[]
  activeTabs: Record<string, string>
  selectedProjectId: string
}

export interface AlertSound {
  name: string
  dataBase64: string
}

export interface CrowAPI {
  getAlertAuditStatus(): Promise<AlertAuditStatus>
  setAlertAuditEnabled(enabled: boolean): Promise<AlertAuditStatus>
  listAlertAudit(): Promise<AlertAuditSummary[]>
  getAlertAudit(id: string): Promise<AlertAuditRecord | undefined>
  clearAlertAudit(): Promise<void>
  exportAlertAudit(): Promise<{ canceled: boolean }>
  reportNoticeSound(hostId: string, eventId: string, outcome: NoticeSoundOutcome): Promise<void>
  notifyCacheExpiry(hostId: string, sessionId: string): Promise<void>
  onCacheWarningClick(listener: (target: { hostId: string; projectId: string; sessionId: string }) => void): () => void
  getAlertAISettings(): Promise<AlertAISettings>
  ensureFreeLLM(): Promise<FreeLLMRuntimeStatus>
  onFreeLLMStatus(listener: (status: FreeLLMRuntimeStatus) => void): () => void
  saveAlertAISettings(input: AlertAIInput): Promise<AlertAISettings>
  testAlertAI(): Promise<AlertAIStatus>
  getAlertAIStatus(): Promise<AlertAIStatus>
  onAlertAIStatus(listener: (status: AlertAIStatus) => void): () => void
  getAlertSound(): Promise<AlertSound | null>
  saveAlertSound(sound: AlertSound): Promise<void>
  clearAlertSound(): Promise<void>
  clipboardReadText(): Promise<string>
  clipboardWriteText(text: string): Promise<void>
  hostMetrics(hostId: string): Promise<HostMetrics>
  mobileAddresses(): Promise<string[]>
  mobileStatus(): Promise<MobileStatus>
  mobileStart(address: string): Promise<MobileStatus>
  mobileStop(): Promise<MobileStatus>
  hookSettings(hostId: string): Promise<{ enabled: boolean }>
  setHookSettings(hostId: string, enabled: boolean): Promise<{ enabled: boolean }>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>
  onUpdateState(listener: (state: UpdateState) => void): () => void
  getState(): Promise<SavedState>
  saveHost(host: Omit<Host, 'id'> & { id?: string }): Promise<SavedState>
  removeHost(id: string): Promise<SavedState>
  saveProject(project: Omit<Project, 'id'> & { id?: string }): Promise<SavedState>
  removeProject(id: string): Promise<SavedState>
  saveWorkspace(tabs: WorkspaceTab[], activeTabs: Record<string, string>, selectedProjectId: string): Promise<SavedState>
  connect(hostId: string): Promise<void>
  submitPassphrase(hostId: string, passphrase: string): Promise<void>
  status(hostId: string): Promise<ConnectionStatus>
  onStatus(listener: (hostId: string, status: ConnectionStatus) => void): () => void
  onPassphraseRequired(listener: (hostId: string) => void): () => void
  onNotice(listener: (notice: Notice) => void): () => void
  markNoticeRead(id: string): Promise<SavedState>
  renameSession(hostId: string, sessionId: string, name: string): Promise<SavedState>
  sessions(hostId: string): Promise<SessionInfo[]>
  startSession(hostId: string, projectId: string, agent: Agent, mode: Mode): Promise<SessionInfo>
  deleteSession(hostId: string, sessionId: string): Promise<SavedState>
  wakeSession(hostId: string, sessionId: string): Promise<SessionInfo>
  attach(hostId: string, sessionId: string, from: number, listener: (frame: TerminalFrame) => void): Promise<string>
  detach(subscriptionId: string): Promise<void>
  terminalInput(subscriptionId: string, data: string): Promise<void>
  terminalResize(subscriptionId: string, cols: number, rows: number): Promise<void>
  files(hostId: string, root: string, path: string): Promise<FileEntry[]>
  readFile(hostId: string, root: string, path: string): Promise<FileContent>
  saveFile(hostId: string, root: string, path: string, content: string, hash: string): Promise<{ hash: string }>
  previewFile(hostId: string, root: string, path: string): Promise<string>
  pickUploadFiles(hostId: string, root: string, directory: string): Promise<FileUploadResult>
  uploadDroppedFile(hostId: string, root: string, directory: string, file: File): Promise<string>
  downloadFile(hostId: string, root: string, path: string): Promise<boolean>
  browserOpen(hostId: string, root: string, url: string): Promise<{ url: string }>
  browserFrame(hostId: string, root: string): Promise<{ data: string; url: string }>
  browserInput(hostId: string, root: string, kind: string, payload?: Record<string, unknown>): Promise<void>
}
