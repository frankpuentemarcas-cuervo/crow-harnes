import { contextBridge, ipcRenderer } from 'electron'
import type { Agent, ConnectionStatus, CrowAPI, Host, Mode, Notice, Project, TerminalFrame, UpdateState, WorkspaceTab } from '../shared/types'

const terminalListeners = new Map<string, (frame: TerminalFrame) => void>()
ipcRenderer.on('crow:terminal-frame', (_event, payload: { id: string; frame: TerminalFrame }) => {
  terminalListeners.get(payload.id)?.(payload.frame)
})

const api: CrowAPI = {
  hostMetrics: (hostId: string) => ipcRenderer.invoke('crow:host-metrics', hostId),
  mobileAddresses: () => ipcRenderer.invoke('crow:mobile-addresses'),
  mobileStatus: () => ipcRenderer.invoke('crow:mobile-status'),
  mobileStart: (address: string) => ipcRenderer.invoke('crow:mobile-start', address),
  mobileStop: () => ipcRenderer.invoke('crow:mobile-stop'),
  hookSettings: (hostId: string) => ipcRenderer.invoke('crow:hook-settings', hostId),
  setHookSettings: (hostId: string, enabled: boolean) => ipcRenderer.invoke('crow:set-hook-settings', hostId, enabled),
  getUpdateState: () => ipcRenderer.invoke('crow:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('crow:check-updates'),
  installUpdate: () => ipcRenderer.invoke('crow:install-update'),
  onUpdateState: (listener: (state: UpdateState) => void) => {
    const wrapped = (_event: unknown, state: UpdateState): void => listener(state)
    ipcRenderer.on('crow:update-state', wrapped)
    return () => { ipcRenderer.off('crow:update-state', wrapped) }
  },
  getState: () => ipcRenderer.invoke('crow:get-state'),
  saveHost: (host: Omit<Host, 'id'> & { id?: string }) => ipcRenderer.invoke('crow:save-host', host),
  removeHost: (id: string) => ipcRenderer.invoke('crow:remove-host', id),
  saveProject: (project: Omit<Project, 'id'> & { id?: string }) => ipcRenderer.invoke('crow:save-project', project),
  removeProject: (id: string) => ipcRenderer.invoke('crow:remove-project', id),
  saveWorkspace: (tabs: WorkspaceTab[], activeTabs: Record<string, string>, selectedProjectId: string) => ipcRenderer.invoke('crow:save-workspace', tabs, activeTabs, selectedProjectId),
  connect: (hostId: string) => ipcRenderer.invoke('crow:connect', hostId),
  submitPassphrase: (hostId: string, passphrase: string) => ipcRenderer.invoke('crow:submit-passphrase', hostId, passphrase),
  status: (hostId: string) => ipcRenderer.invoke('crow:status', hostId),
  onPassphraseRequired: (listener: (hostId: string) => void) => {
    const wrapped = (_event: unknown, hostId: string): void => listener(hostId)
    ipcRenderer.on('crow:passphrase-required', wrapped)
    return () => { ipcRenderer.off('crow:passphrase-required', wrapped) }
  },
  onStatus: (listener: (hostId: string, status: ConnectionStatus) => void) => {
    const wrapped = (_event: unknown, value: { hostId: string; status: ConnectionStatus }): void => listener(value.hostId, value.status)
    ipcRenderer.on('crow:status', wrapped)
    return () => { ipcRenderer.off('crow:status', wrapped) }
  },
  onNotice: (listener: (notice: Notice) => void) => {
    const wrapped = (_event: unknown, notice: Notice): void => listener(notice)
    ipcRenderer.on('crow:notice', wrapped)
    return () => { ipcRenderer.off('crow:notice', wrapped) }
  },
  markNoticeRead: (id: string) => ipcRenderer.invoke('crow:notice-read', id),
  sessions: (hostId: string) => ipcRenderer.invoke('crow:sessions', hostId),
  startSession: (hostId: string, projectId: string, agent: Agent, mode: Mode) => ipcRenderer.invoke('crow:start-session', hostId, projectId, agent, mode),
  deleteSession: (hostId: string, sessionId: string) => ipcRenderer.invoke('crow:delete-session', hostId, sessionId),
  wakeSession: (hostId: string, sessionId: string) => ipcRenderer.invoke('crow:wake-session', hostId, sessionId),
  attach: async (hostId: string, sessionId: string, from: number, listener: (frame: TerminalFrame) => void) => {
    const id = crypto.randomUUID()
    terminalListeners.set(id, listener)
    try {
      await ipcRenderer.invoke('crow:attach', hostId, sessionId, from, id)
      return id
    } catch (error) {
      terminalListeners.delete(id)
      throw error
    }
  },
  detach: async (id: string) => {
    terminalListeners.delete(id)
    await ipcRenderer.invoke('crow:detach', id)
  },
  terminalInput: (id: string, data: string) => ipcRenderer.invoke('crow:terminal-input', id, data),
  terminalResize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('crow:terminal-resize', id, cols, rows),
  files: (hostId: string, root: string, path: string) => ipcRenderer.invoke('crow:files', hostId, root, path),
  readFile: (hostId: string, root: string, path: string) => ipcRenderer.invoke('crow:read-file', hostId, root, path),
  saveFile: (hostId: string, root: string, path: string, content: string, hash: string) => ipcRenderer.invoke('crow:save-file', hostId, root, path, content, hash),
  previewFile: (hostId: string, root: string, path: string) => ipcRenderer.invoke('crow:preview-file', hostId, root, path),
  browserOpen: (hostId: string, root: string, url: string) => ipcRenderer.invoke('crow:browser-open', hostId, root, url),
  browserFrame: (hostId: string, root: string) => ipcRenderer.invoke('crow:browser-frame', hostId, root),
  browserInput: (hostId: string, root: string, kind: string, payload?: Record<string, unknown>) => ipcRenderer.invoke('crow:browser-input', hostId, root, kind, payload)
}

contextBridge.exposeInMainWorld('crow', api)
