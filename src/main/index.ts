import { app, BrowserWindow, clipboard, ipcMain, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'
import { Connection } from './connection'
import { PassphraseVault } from './passphrase-vault'
import { MobileGateway, mobileAddresses } from './mobile-gateway'
import { Store } from './store'
import type { Agent, Host, HostMetrics, Mode, Notice, Project, SessionInfo, FileEntry, FileContent, UpdateState, WorkspaceTab } from '../shared/types'

let window: BrowserWindow | undefined
let store: Store
let vault: PassphraseVault
let mobile: MobileGateway
const connections = new Map<string, Connection>()
let updateState: UpdateState = { status: 'idle' }

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function setUpdateState(next: UpdateState): void {
  updateState = next
  send('crow:update-state', updateState)
}

function configureUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking' }))
  autoUpdater.on('update-available', (info) => setUpdateState({ status: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'up-to-date' }))
  autoUpdater.on('download-progress', (progress) => setUpdateState({ status: 'downloading', percent: Math.round(progress.percent) }))
  autoUpdater.on('update-downloaded', (info) => setUpdateState({ status: 'downloaded', version: info.version }))
  autoUpdater.on('error', () => setUpdateState({ status: 'error' }))

  if (app.isPackaged) setTimeout(() => { void autoUpdater.checkForUpdates().catch(() => undefined) }, 1500)
}

function connection(hostId: string): Connection {
  const host = store.host(hostId)
  if (!host) throw new Error('Host desconocido.')
  let current = connections.get(hostId)
  if (!current) {
    current = new Connection(host, store, vault, (id, status) => send('crow:status', { hostId: id, status }), onNotice, (id) => send('crow:passphrase-required', id))
    connections.set(hostId, current)
  }
  return current
}

function onNotice(notice: Notice): void {
  send('crow:notice', notice)
  if (Notification.isSupported() && Date.now() - Date.parse(notice.at) < 60 * 60 * 1000) {
    const host = store.host(notice.hostId)
    const title = notice.kind === 'turn-complete' ? 'Agente terminó el trabajo' : 'Agente finalizó'
    const item = new Notification({ title, body: `${host?.name || 'Host'} · sesión ${notice.sessionId.slice(0, 8)}`, silent: true })
    item.on('click', () => { window?.show(); window?.focus() })
    item.show()
  }
}

function projectRoot(hostId: string, root: string): void {
  if (!store.snapshot().projects.some((project) => project.hostId === hostId && project.root === root)) {
    throw new Error('La carpeta no pertenece a un proyecto configurado.')
  }
}

function byStream(id: string): Connection {
  const found = [...connections.values()].find((item) => item.ownsStream(id))
  if (!found) throw new Error('La terminal está desconectada.')
  return found
}

function registerIPC(): void {
  const handle = (channel: string, listener: (...args: any[]) => any): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!window || event.sender !== window.webContents) throw new Error('Solicitud no autorizada.')
      return listener(...args)
    })
  }

  handle('crow:clipboard-read', () => clipboard.readText())
  handle('crow:clipboard-write', (text: string) => {
    if (typeof text !== 'string') throw new Error('Texto de portapapeles inválido.')
    clipboard.writeText(text)
  })
  handle('crow:get-state', () => store.snapshot())
  handle('crow:update-state', () => updateState)
  handle('crow:check-updates', async () => {
    if (app.isPackaged) await autoUpdater.checkForUpdates()
  })
  handle('crow:install-update', () => {
    if (!app.isPackaged || updateState.status !== 'downloaded') throw new Error('Todavía no hay una actualización lista para instalar.')
    autoUpdater.quitAndInstall(false, true)
  })
  handle('crow:save-host', (host: Omit<Host, 'id'> & { id?: string }) => {
    if (host.id) { connections.get(host.id)?.stop(); connections.delete(host.id) }
    if (host.id && store.host(host.id)?.identity !== host.identity) vault.forget(host.id)
    return store.saveHost(host)
  })
  handle('crow:remove-host', (id: string) => {
    connections.get(id)?.stop()
    connections.delete(id)
    vault.forget(id)
    return store.removeHost(id)
  })
  handle('crow:save-project', (project: Omit<Project, 'id'> & { id?: string }) => store.saveProject(project))
  handle('crow:remove-project', (id: string) => store.removeProject(id))
  handle('crow:save-workspace', (tabs: WorkspaceTab[], activeTabs: Record<string, string>, selectedProjectId: string) => store.saveWorkspace(tabs, activeTabs, selectedProjectId))
  handle('crow:connect', (hostId: string) => connection(hostId).connect())
  handle('crow:submit-passphrase', (hostId: string, passphrase: string) => connection(hostId).submitPassphrase(passphrase))
  handle('crow:status', (hostId: string) => connection(hostId).status())
  handle('crow:notice-read', (id: string) => store.markNoticeRead(id))
  handle('crow:sessions', (hostId: string) => connection(hostId).api<SessionInfo[]>('GET', '/api/sessions'))
  handle('crow:host-metrics', (hostId: string) => connection(hostId).api<HostMetrics>('GET', '/api/host/metrics'))
  handle('crow:mobile-addresses', () => mobileAddresses())
  handle('crow:mobile-status', () => mobile.status())
  handle('crow:mobile-start', (address: string) => mobile.start(address))
  handle('crow:mobile-stop', () => mobile.stop())
  handle('crow:hook-settings', (hostId: string) => connection(hostId).api<{ enabled: boolean }>('GET', '/api/hooks'))
  handle('crow:set-hook-settings', (hostId: string, enabled: boolean) => connection(hostId).api<{ enabled: boolean }>('PUT', '/api/hooks', { enabled }))
  handle('crow:start-session', (hostId: string, projectId: string, agent: Agent, mode: Mode) => {
    const project = store.project(projectId)
    if (!project || project.hostId !== hostId) throw new Error('Proyecto desconocido.')
    return connection(hostId).api<SessionInfo>('POST', '/api/sessions', { agent, mode, root: project.root })
  })
  handle('crow:delete-session', async (hostId: string, sessionId: string) => {
    if (!/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Sesión inválida.')
    await connection(hostId).api('DELETE', `/api/sessions/${sessionId}`)
    return store.removeSession(hostId, sessionId)
  })
  handle('crow:wake-session', (hostId: string, sessionId: string) => {
    if (!/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Sesión inválida.')
    return connection(hostId).api<SessionInfo>('POST', `/api/sessions/${sessionId}/wake`)
  })
  handle('crow:attach', async (hostId: string, sessionId: string, from: number, id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Suscripción inválida.')
    await connection(hostId).attach(id, sessionId, from, (frame) => send('crow:terminal-frame', { id, frame }))
    return id
  })
  handle('crow:detach', (id: string) => { byStream(id).detach(id) })
  handle('crow:terminal-input', (id: string, data: string) => byStream(id).send(id, { type: 'input', data: Buffer.from(data, 'utf8').toString('base64') }))
  handle('crow:terminal-resize', (id: string, cols: number, rows: number) => byStream(id).send(id, { type: 'resize', cols, rows }))
  handle('crow:files', (hostId: string, root: string, path: string) => {
    projectRoot(hostId, root)
    return connection(hostId).api<FileEntry[]>('GET', `/api/files/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
  })
  handle('crow:read-file', (hostId: string, root: string, path: string) => {
    projectRoot(hostId, root)
    return connection(hostId).api<FileContent>('GET', `/api/files/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
  })
  handle('crow:save-file', (hostId: string, root: string, path: string, content: string, hash: string) => {
    projectRoot(hostId, root)
    return connection(hostId).api<{ hash: string }>('PUT', '/api/files/content', { root, path, content, hash })
  })
  handle('crow:preview-file', async (hostId: string, root: string, path: string) => {
    projectRoot(hostId, root)
    const result = await connection(hostId).binary(`/api/files/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
    return `data:${result.type};base64,${result.data}`
  })
  handle('crow:browser-open', (hostId: string, root: string, url: string) => {
    projectRoot(hostId, root)
    return connection(hostId).api<{ url: string }>('POST', '/api/browser/open', { root, url })
  })
  handle('crow:browser-frame', async (hostId: string, root: string) => {
    projectRoot(hostId, root)
    const result = await connection(hostId).binary(`/api/browser/frame?root=${encodeURIComponent(root)}`)
    return { data: `data:${result.type};base64,${result.data}`, url: result.url }
  })
  handle('crow:browser-input', (hostId: string, root: string, kind: string, payload?: Record<string, unknown>) => {
    projectRoot(hostId, root)
    return connection(hostId).api('POST', '/api/browser/input', { root, kind, ...payload })
  })
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1050,
    minHeight: 650,
    backgroundColor: '#0a0a0a',
    title: 'Crow Harness',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  window.on('closed', () => { window = undefined })
}

app.whenReady().then(() => {
  store = new Store()
  vault = new PassphraseVault()
  mobile = new MobileGateway({ snapshot: () => store.snapshot(), connection })
  registerIPC()
  createWindow()
  configureUpdater()
  for (const host of store.snapshot().hosts) void connection(host.id).connect().catch(() => undefined)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { void mobile?.stop(); for (const item of connections.values()) item.stop() })
