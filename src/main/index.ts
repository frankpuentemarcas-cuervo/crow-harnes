import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, safeStorage } from 'electron'
import { autoUpdater } from 'electron-updater'
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { Connection } from './connection'
import { PassphraseVault } from './passphrase-vault'
import { MobileGateway, mobileAddresses } from './mobile-gateway'
import { Store } from './store'
import { AlertSoundStore } from './alert-sound-store'
import { AlertAISettingsStore } from './alert-ai-settings'
import { AttentionService } from './attention-service'
import { FreeLLMRuntime } from './free-llm-runtime'
import { AlertAuditStore } from './alert-audit-store'
import { AccountUsageService } from './account-usage-service'
import { ERPTaskService } from './erp-task-service'
import type { ERPConnectionInput, ERPDispatchJob, ERPProjectCandidate, ERPTaskPreviewInput, ERPTaskStage } from '../shared/erp-task'
import type { CrowAccessUserInput, SavedState } from '../shared/types'
import { projectVisibleSessions, withoutHostWorkspace } from '../shared/access-visibility'
import { createAccountUsageAdapters } from './account-usage-adapters'
import type { NoticeSoundOutcome } from '../shared/alert-diagnostics'
import { BridgeGateway } from './bridge-gateway'
import { readBridgePolicy } from './bridge-policy'
import { BridgeRegistry } from './bridge-registry'
import { BridgeService } from './bridge-service'
import { ignoreClipboardMenuShortcut } from './clipboard-shortcuts'
import type { Agent, AlertAIInput, AlertSound, Host, HostMetrics, Mode, Notice, Project, SessionInfo, FileEntry, FileContent, FileUploadResult, UpdateState, WorkspaceTab } from '../shared/types'

let window: BrowserWindow | undefined
let store: Store
let alertSoundStore: AlertSoundStore
let alertAISettings: AlertAISettingsStore
let attention: AttentionService
let freeLLM: FreeLLMRuntime
let alertAudit: AlertAuditStore
let accountUsage: AccountUsageService
let erpTasks: ERPTaskService
let erpProjects: ERPProjectCandidate[] = []
let erpQueue: Promise<unknown> = Promise.resolve()
let accessGeneration = 0
let auditTimer: NodeJS.Timeout | undefined
let vault: PassphraseVault
let mobile: MobileGateway
let bridge: BridgeGateway | undefined
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
    current = new Connection(host, store, vault, (id, status) => { erpProjects = []; send('crow:status', { hostId: id, status }); if (status === 'connected') void erpOperation(() => undefined) }, (id, event) => attention.receive(id, event), (id) => send('crow:passphrase-required', id), () => attention.enabled())
    connections.set(hostId, current)
  }
  return current
}

function onNotice(notice: Notice): void {
  send('crow:notice', notice)
  if (notice.requiresAttention && !notice.read && Notification.isSupported() && Date.now() - Date.parse(notice.at) < 60 * 60 * 1000) {
    const host = store.host(notice.hostId)
    const title = notice.requiresAttention ? 'Agente necesita tu atención' : notice.kind === 'turn-complete' ? 'Trabajo terminado' : 'Agente finalizó'
    const session = store.sessionName(notice.hostId, notice.sessionId)
    const item = new Notification({ title, body: `${host?.name || 'Host'} · ${session || `sesión ${notice.sessionId.slice(0, 8)}`}`, silent: true })
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

async function uploadLocalFiles(hostId: string, root: string, directory: string, paths: string[]): Promise<FileUploadResult> {
  projectRoot(hostId, root)
  if (!Array.isArray(paths) || paths.length > 100 || paths.some((path) => typeof path !== 'string')) {
    throw new Error('Selección de archivos inválida (máximo 100 por vez).')
  }
  const uploaded: string[] = []
  const failed: FileUploadResult['failed'] = []
  for (const path of paths) {
    try { uploaded.push(await connection(hostId).uploadLocalFile(root, directory, path)) }
    catch (reason) { failed.push({ name: basename(path), error: reason instanceof Error ? reason.message : String(reason) }) }
  }
  return { uploaded, failed, canceled: false }
}

async function authorizeERPProject(projectId: string, hostId: string): Promise<{ actorId: string; root: string }> {
  const project = store.project(projectId)
  if (!project || project.hostId !== hostId) throw new Error('Proyecto desconocido.')
  const current = connection(hostId)
  if (current.status() !== 'connected') throw new Error('Conectá el host antes de autorizar la Task.')
  const status = await current.accessStatus(), identity = await current.accessIdentity()
  if (!status.enabled && identity.role === 'legacy') return { actorId: `legacy:${hostId}`, root: posix.normalize(project.root) }
  if (!status.enabled || identity.role === 'legacy' || identity.revoked) throw new Error('Identidad Crow no válida.')
  const canonicalRoot = posix.normalize(project.root)
  if (canonicalRoot !== project.root || !canonicalRoot.startsWith('/') || !identity.allowedRoots.some(root => canonicalRoot === root || canonicalRoot.startsWith(root.replace(/\/$/, '') + '/'))) throw new Error('La identidad Crow no permite este proyecto.')
  return { actorId: identity.id, root: canonicalRoot }
}

async function refreshERPProjects(): Promise<void> {
  erpProjects = []
  const permitted: ERPProjectCandidate[] = []
  for (const project of store.snapshot().projects) {
    try { await authorizeERPProject(project.id, project.hostId); permitted.push({ id: project.id, name: project.name, hostId: project.hostId }) }
    catch { /* Disconnected/revoked identities are never candidate projects. */ }
  }
  erpProjects = permitted
}

function erpOperation<T>(action: () => T | Promise<T>): Promise<T> {
  // Serialize authorization windows: one operation cannot replace another's cache.
  const next = erpQueue.catch(() => undefined).then(async () => { await refreshERPProjects(); return action() })
  erpQueue = next.then(() => undefined, () => undefined)
  return next
}

async function dispatchERPTask(job: ERPDispatchJob): Promise<{ sessionId: string }> {
  const authorized = await authorizeERPProject(job.projectId, job.hostId)
  if (authorized.root !== job.root || authorized.actorId !== job.actorId) throw new Error('El destino o identidad cambió; autorizá nuevamente.')
  const result = await connection(job.hostId).api<{ sessionId?: string; session?: SessionInfo; state?: string }>('POST', '/api/task-dispatch', { jobId: job.jobId, agent: job.agent, root: job.root, prompt: job.initialPrompt })
  const sessionId = result.sessionId || result.session?.id
  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Entrega incierta: revisá la terminal antes de continuar.')
  return { sessionId }
}

async function visibleState(value: SavedState): Promise<SavedState> {
  const generation = accessGeneration
  const visible = new Set<string>()
  await Promise.all(value.hosts.map(async host => {
    const current = connections.get(host.id)
    if (current?.status() !== 'connected') return
    try { for (const session of await current.api<SessionInfo[]>('GET', '/api/sessions')) visible.add(`${host.id}:${session.id}`) }
    catch { /* Fail closed on expired/revoked credential or unavailable service. */ }
  }))
  return projectVisibleSessions(value, generation === accessGeneration ? visible : new Set())
}

function clearHostIdentityCaches(hostId: string): void {
  accessGeneration++
  // Paired mobile/MCP clients must not silently inherit a replacement identity.
  void mobile?.stop()
  void bridge?.stop()
  bridge = undefined
  attention.reset()
  erpProjects = []
  const saved = store.snapshot()
  const projects = new Set(saved.projects.filter(project => project.hostId === hostId).map(project => project.id))
  const ids = new Set([...saved.notices.filter(notice => notice.hostId === hostId).map(notice => notice.sessionId), ...Object.keys(saved.sessionNames).filter(key => key.startsWith(hostId + ':')).map(key => key.slice(hostId.length + 1)), ...saved.tabs.filter(tab => projects.has(tab.projectId) && tab.sessionId).map(tab => tab.sessionId!)])
  for (const id of ids) store.removeSession(hostId, id)
  const cleared = withoutHostWorkspace(saved, hostId)
  store.saveWorkspace(cleared.tabs, cleared.activeTabs, cleared.selectedProjectId)
  send('crow:access-changed', hostId)
}

function scopedWorkspaceSnapshot(): SavedState {
  const saved = store.snapshot(), permitted = new Set(erpProjects.map(project => project.id))
  const projects = saved.projects.filter(project => permitted.has(project.id))
  const hosts = saved.hosts.filter(host => projects.some(project => project.hostId === host.id))
  return { ...saved, hosts, projects, notices: [], sessionNames: {}, tabs: [], activeTabs: {}, eventCursors: {} }
}

async function visibleAuditRecords<T extends { hostId: string; sessionId: string }>(rows: T[]): Promise<T[]> {
  const generation = accessGeneration
  const allowedHosts = new Set<string>(), sessions = new Set<string>()
  await Promise.all([...new Set(rows.map(row => row.hostId))].map(async hostId => {
    const current = connections.get(hostId)
    if (!store.host(hostId) || current?.status() !== 'connected') return
    try {
      const identity = await current.accessIdentity()
      if (identity.role === 'admin' || identity.role === 'legacy') { allowedHosts.add(hostId); return }
      if (identity.revoked) return
      for (const session of await current.api<SessionInfo[]>('GET', '/api/sessions')) sessions.add(`${hostId}:${session.id}`)
    } catch { /* Historical diagnostics also require current permission. */ }
  }))
  return generation === accessGeneration ? rows.filter(row => /^[0-9a-f]{32}$/.test(row.sessionId) && (allowedHosts.has(row.hostId) || sessions.has(`${row.hostId}:${row.sessionId}`))) : []
}

async function scopedAuditStatus(): Promise<ReturnType<AlertAuditStore['status']>> {
  return { ...alertAudit.status(), count: (await visibleAuditRecords(alertAudit.list())).length }
}

function registerIPC(): void {
  const handle = (channel: string, listener: (...args: any[]) => any): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!window || event.sender !== window.webContents) throw new Error('Solicitud no autorizada.')
      const result = await listener(...args)
      return result && Array.isArray(result.hosts) && Array.isArray(result.notices) && Array.isArray(result.tabs) ? visibleState(result) : result
    })
  }

  handle('crow:access-status', (hostId: string) => connection(hostId).accessStatus())
  handle('crow:access-identity', (hostId: string) => connection(hostId).accessIdentity())
  handle('crow:access-enable', (hostId: string, label: string) => erpOperation(async () => { clearHostIdentityCaches(hostId); const result = await connection(hostId).enableAccess(label); clearHostIdentityCaches(hostId); return { principal: result.principal, credential: '' } }))
  handle('crow:access-import', (hostId: string, credential: string) => erpOperation(async () => { clearHostIdentityCaches(hostId); await connection(hostId).setAccessCredential(credential); clearHostIdentityCaches(hostId) }))
  handle('crow:access-users', (hostId: string) => connection(hostId).listAccessUsers())
  handle('crow:access-create-user', (hostId: string, input: CrowAccessUserInput) => connection(hostId).createAccessUser(input))
  handle('crow:access-revoke-user', (hostId: string, id: string) => connection(hostId).revokeAccessUser(id))
  handle('crow:access-assign-session', (hostId: string, sessionId: string, ownerId: string) => connection(hostId).assignSessionOwner(sessionId, ownerId))
  handle('crow:erp-snapshot', () => erpOperation(() => erpTasks.snapshot()))
  handle('crow:erp-projects', () => erpOperation(() => [...erpProjects]))
  handle('crow:erp-save', (input: ERPConnectionInput) => erpOperation(() => erpTasks.saveConnection(input)))
  handle('crow:erp-test', () => erpOperation(() => erpTasks.testConnection()))
  handle('crow:erp-sync', () => erpOperation(() => erpTasks.sync()))
  handle('crow:erp-link', (erpProject: string, projectId: string) => erpOperation(() => erpTasks.linkProject(erpProject, projectId)))
  handle('crow:erp-classify', (taskKey: string) => erpOperation(() => erpTasks.classify(taskKey)))
  handle('crow:erp-assign', (taskKey: string, projectId: string) => erpOperation(() => erpTasks.assign(taskKey, projectId)))
  handle('crow:erp-preview', (input: ERPTaskPreviewInput) => erpOperation(() => erpTasks.preview(input)))
  handle('crow:erp-approve', (previewId: string) => erpOperation(() => erpTasks.approve(previewId)))
  handle('crow:erp-move', (taskKey: string, stage: ERPTaskStage) => erpOperation(() => erpTasks.move(taskKey, stage)))
  handle('crow:clipboard-read', () => clipboard.readText())
  handle('crow:accounts-list', () => accountUsage.list())
  handle('crow:accounts-add', (input: unknown) => accountUsage.add(input))
  handle('crow:accounts-login', (id: string) => accountUsage.login(id))
  handle('crow:accounts-refresh', (id: string) => accountUsage.refresh(id))
  handle('crow:accounts-remove', (id: string) => accountUsage.remove(id))
  handle('crow:audit-status', () => scopedAuditStatus())
  handle('crow:audit-enabled', async (enabled: boolean) => { alertAudit.setEnabled(enabled); return scopedAuditStatus() })
  handle('crow:audit-list', () => visibleAuditRecords(alertAudit.list()))
  handle('crow:audit-detail', async (id: string) => { const row = alertAudit.detail(id); return row ? (await visibleAuditRecords([row]))[0] : undefined })
  handle('crow:audit-clear', () => alertAudit.clear())
  handle('crow:audit-sound', (hostId: string, eventId: string, outcome: NoticeSoundOutcome) => {
    if (typeof hostId !== 'string' || typeof eventId !== 'string' || typeof outcome !== 'string') throw new Error('Diagnóstico de audio inválido.')
    alertAudit.sound(hostId, eventId, outcome)
  })
  handle('crow:audit-export', async () => {
    if (!window) return { canceled: true }
    const result = await dialog.showSaveDialog(window, { title: 'Exportar diagnóstico · contiene texto privado SIN cifrar', defaultPath: join(app.getPath('downloads'), `crow-alertas-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'JSON de diagnóstico', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return { canceled: true }
    const inside = relative(resolve(app.getPath('userData')), resolve(result.filePath))
    if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new Error('Exportá fuera de la carpeta interna de Crow.')
    const exportData = JSON.parse(alertAudit.exportJSON())
    exportData.records = await visibleAuditRecords(exportData.records)
    await writeFile(result.filePath, JSON.stringify(exportData, null, 2), { encoding: 'utf8', mode: 0o600 })
    return { canceled: false }
  })
  handle('crow:get-alert-ai-settings', () => alertAISettings.snapshot())
  handle('crow:ensure-free-llm', () => freeLLM.ensure())
  handle('crow:save-alert-ai-settings', (input: AlertAIInput) => {
    const next = alertAISettings.save(input)
    attention.reset()
    freeLLM.reset()
    return next
  })
  handle('crow:test-alert-ai', () => attention.testConnection())
  handle('crow:alert-ai-status', () => attention.snapshot())
  handle('crow:get-alert-sound', () => alertSoundStore.load())
  handle('crow:save-alert-sound', (sound: AlertSound) => alertSoundStore.save(sound))
  handle('crow:clear-alert-sound', () => alertSoundStore.clear())
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
  handle('crow:rename-session', async (hostId: string, sessionId: string, name: string) => {
    const sessions = await connection(hostId).api<SessionInfo[]>('GET', '/api/sessions')
    if (!sessions.some(session => session.id === sessionId && !session.readOnly)) throw new Error('Terminal no permitida para renombrar.')
    return store.renameSession(hostId, sessionId, name)
  })
  handle('crow:sessions', (hostId: string) => connection(hostId).api<SessionInfo[]>('GET', '/api/sessions'))
  handle('crow:cache-warning', async (hostId: string, sessionId: string) => {
    if (!/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Sesión inválida.')
    const host = store.host(hostId)
    if (!host || connection(hostId).status() !== 'connected') return
    const sessions = await connection(hostId).api<SessionInfo[]>('GET', '/api/sessions')
    const session = sessions.find(item => item.id === sessionId && item.agent === 'claude')
    const project = store.snapshot().projects.find(item => item.hostId === hostId && item.root === session?.root)
    const cache = session?.promptCache
    const remaining = Date.parse(cache?.expiresAt || '') - (Date.parse(cache?.serverTime || '') || Date.now())
    if (!project || !session?.hooksActive || !['running', 'sleeping'].includes(session.state) || session.agentState === 'working' || cache?.source !== 'claude-statusline' || !cache.warm || !Number.isFinite(remaining) || remaining <= 0 || remaining > 300000 || !Notification.isSupported()) return
    const item = new Notification({ title: 'Caché Claude por vencer', body: `${host.name} · ${store.sessionName(hostId, sessionId) || `sesión ${sessionId.slice(0, 8)}`}. No se perderá la conversación.`, silent: true })
    item.on('click', () => { window?.show(); window?.focus(); send('crow:cache-warning-click', { hostId, projectId: project.id, sessionId }) })
    item.show() // Separate advisory: never stored as an agent notice or classified by Free LLM.
  })
  handle('crow:host-metrics', (hostId: string) => connection(hostId).api<HostMetrics>('GET', '/api/host/metrics'))
  handle('crow:mobile-addresses', () => mobileAddresses())
  handle('crow:mobile-status', () => mobile.status())
  handle('crow:mobile-start', (address: string) => erpOperation(() => mobile.start(address)))
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
  handle('crow:pick-upload-files', async (hostId: string, root: string, directory: string) => {
    projectRoot(hostId, root)
    if (!window) throw new Error('Ventana no disponible.')
    const choice = await dialog.showOpenDialog(window, { title: 'Subir archivos al servidor', properties: ['openFile', 'multiSelections'] })
    if (choice.canceled) return { uploaded: [], failed: [], canceled: true } satisfies FileUploadResult
    return uploadLocalFiles(hostId, root, directory, choice.filePaths)
  })
  handle('crow:upload-dropped-file', (hostId: string, root: string, directory: string, path: string) => {
    projectRoot(hostId, root)
    return connection(hostId).uploadLocalFile(root, directory, path)
  })
  handle('crow:download-file', async (hostId: string, root: string, path: string) => {
    projectRoot(hostId, root)
    if (!window || !path || path.endsWith('/')) throw new Error('Archivo inválido.')
    const choice = await dialog.showSaveDialog(window, { title: 'Descargar archivo del servidor', defaultPath: posix.basename(path) })
    if (choice.canceled || !choice.filePath) return false
    await connection(hostId).downloadFile(root, path, choice.filePath)
    return true
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
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('before-input-event', (_event, input) => {
    window?.webContents.setIgnoreMenuShortcuts(ignoreClipboardMenuShortcut(input))
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  window.on('closed', () => { window = undefined })
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'))
  accountUsage = new AccountUsageService(app.getPath('userData'), createAccountUsageAdapters())
  alertSoundStore = new AlertSoundStore(app.getPath('userData'))
  alertAISettings = new AlertAISettingsStore(app.getPath('userData'), safeStorage)
  erpTasks = new ERPTaskService(app.getPath('userData'), safeStorage, { projects: () => [...erpProjects], aiConfiguration: () => alertAISettings.configuration(), authorizeProject: authorizeERPProject, dispatch: dispatchERPTask })
  freeLLM = new FreeLLMRuntime(() => alertAISettings.snapshot(), (status) => send('crow:free-llm-status', status))
  alertAudit = new AlertAuditStore(app.getPath('userData'), safeStorage, Date.now, () => { try { return [alertAISettings.configuration().apiKey] } catch { return [] } })
  auditTimer = setInterval(() => alertAudit.prune(), 60_000)
  auditTimer.unref()
  attention = new AttentionService(store, alertAISettings, onNotice, (status) => send('crow:alert-ai-status', status), undefined, Date.now, alertAudit)
  vault = new PassphraseVault()
  mobile = new MobileGateway({ snapshot: scopedWorkspaceSnapshot, connection })
  registerIPC()
  createWindow()
  configureUpdater()
  // Explicit owner opt-in. No new listeners or permissions by default; reuse
  // the exact Connection/passphrase path already used by the desktop app.
  if (process.env.CROW_MCP_CONFIG) {
    try {
      bridge = new BridgeGateway(readBridgePolicy(process.env.CROW_MCP_CONFIG), () => new BridgeService(new BridgeRegistry(app.getPath('userData')), { snapshot: scopedWorkspaceSnapshot, sessionName: () => undefined }, connection))
      void bridge.start().catch(() => { console.error('Crow MCP no pudo iniciarse. Revisá el puerto/configuración local.'); bridge = undefined })
    } catch { console.error('Crow MCP deshabilitado: configuración local inválida.') }
  }
  for (const host of store.snapshot().hosts) void connection(host.id).connect().catch(() => undefined)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { erpTasks?.stop(); accountUsage?.stop(); if (auditTimer) clearInterval(auditTimer); freeLLM?.stop(); attention?.stop(); void mobile?.stop(); void bridge?.stop(); for (const item of connections.values()) item.stop() })
