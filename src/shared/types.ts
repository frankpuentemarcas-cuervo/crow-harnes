export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'auth-required'
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
  state: 'running' | 'exited' | 'interrupted'
  startedAt: string
  updatedAt: string
  seq: number
  exitCode?: number
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
  at: string
}

export interface Notice extends RemoteEvent {
  hostId: string
  read: boolean
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
  eventCursors: Record<string, number>
  tabs: WorkspaceTab[]
  activeTabs: Record<string, string>
  selectedProjectId: string
}

export interface CrowAPI {
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
  sessions(hostId: string): Promise<SessionInfo[]>
  startSession(hostId: string, projectId: string, agent: Agent, mode: Mode): Promise<SessionInfo>
  attach(hostId: string, sessionId: string, from: number, listener: (frame: TerminalFrame) => void): Promise<string>
  detach(subscriptionId: string): Promise<void>
  terminalInput(subscriptionId: string, data: string): Promise<void>
  terminalResize(subscriptionId: string, cols: number, rows: number): Promise<void>
  files(hostId: string, root: string, path: string): Promise<FileEntry[]>
  readFile(hostId: string, root: string, path: string): Promise<FileContent>
  saveFile(hostId: string, root: string, path: string, content: string, hash: string): Promise<{ hash: string }>
  previewFile(hostId: string, root: string, path: string): Promise<string>
  browserOpen(hostId: string, root: string, url: string): Promise<{ url: string }>
  browserFrame(hostId: string, root: string): Promise<{ data: string; url: string }>
  browserInput(hostId: string, root: string, kind: string, payload?: Record<string, unknown>): Promise<void>
}
