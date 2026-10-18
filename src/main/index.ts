import { workspaceWindowPlacement } from '../shared/window-layout'
import { app, BrowserWindow, screen, clipboard, dialog, ipcMain, Notification, safeStorage, shell } from 'electron'
import QRCode from 'qrcode'
import { autoUpdater } from 'electron-updater'
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { Connection } from './connection'
import { ConnectionDiagnosticsStore } from './connection-diagnostics'
import { TerminalCheckpointStore } from './terminal-checkpoint-store'
import { PassphraseVault } from './passphrase-vault'
import { MobileGateway, mobileAddresses } from './mobile-gateway'
import { MobileRelayClient } from './mobile-relay-client'
import { MobileHostUnavailableError, MobileAuthorizationChangedError } from './mobile-device-auth'
import { Store } from './store'
import { AlertSoundStore } from './alert-sound-store'
import { AlertAISettingsStore } from './alert-ai-settings'
import { AttentionService } from './attention-service'
import { FreeLLMRuntime } from './free-llm-runtime'
import { AlertAuditStore } from './alert-audit-store'
import { AccountUsageService } from './account-usage-service'
import { ERPTaskService } from './erp-task-service'
import { ClaudeConversationService } from './claude-conversations'
import { GitLabTokenStore, listGitLabProjectFiles, readGitLabProjectFiles } from './gitlab-repository'
import type { ERPConnectionInput, ERPDispatchJob, ERPProjectCandidate, ERPTaskPreviewInput, ERPTaskStage, ERPTerminalTarget, ERPTerminalCandidate, ERPDispatchTarget, ERPExistingTerminalInput, ERPTerminalCatalogue } from '../shared/erp-task'
import type { CrowAccessUserInput, GitLabRepositoryContext, ProjectInput, SavedState } from '../shared/types'
import type { MobileActorBinding, MobileEnrollmentInput, MobileNotice, MobileQuota, MobileStartInput } from '../shared/mobile-companion'
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
let connectionDiagnostics: ConnectionDiagnosticsStore
let terminalCheckpoints: TerminalCheckpointStore
let alertSoundStore: AlertSoundStore
let alertAISettings: AlertAISettingsStore
let attention: AttentionService
let freeLLM: FreeLLMRuntime
let alertAudit: AlertAuditStore
let accountUsage: AccountUsageService
let erpTasks: ERPTaskService
let claudeConversations: ClaudeConversationService
let gitLabTokens: GitLabTokenStore
let erpProjects: ERPProjectCandidate[] = []
let erpQueue: Promise<unknown> = Promise.resolve()
let accessGeneration = 0
const mobileHostGenerations = new Map<string, number>()
const mobileActorRoots = new Map<string, string[]>()
let auditTimer: NodeJS.Timeout | undefined
let vault: PassphraseVault
let mobile: MobileGateway
let bridge: BridgeGateway | undefined
const connections = new Map<string, Connection>()
const terminalMetadataOperations = new Map<string, Promise<unknown>>()
let updateState: UpdateState = { status: 'idle' }

function terminalMetadataOperation<T>(hostId: string, sessionId: string, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([hostId, sessionId])
  const operation = (terminalMetadataOperations.get(key) || Promise.resolve()).catch(() => undefined).then(action)
  terminalMetadataOperations.set(key, operation)
  void operation.finally(() => { if (terminalMetadataOperations.get(key) === operation) terminalMetadataOperations.delete(key) }).catch(() => undefined)
  return operation
}

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
    current = new Connection(host, store, vault, (id, status) => { if (status !== 'connected') suspendMobileHost(id); erpProjects = []; send('crow:status', { hostId: id, status }); if (status === 'connected') void erpOperation(() => undefined) }, (id, event) => attention.receive(id, event), (id) => send('crow:passphrase-required', id), () => attention.enabled(), undefined, entry => connectionDiagnostics.record({ ...entry, hostId }))
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
  if ((!status.enabled && identity.role !== 'installation') || identity.role === 'legacy' || identity.revoked) throw new Error('Identidad Crow no válida.')
  const canonicalRoot = posix.normalize(project.root)
  if (canonicalRoot !== project.root || !canonicalRoot.startsWith('/') || (identity.role !== 'installation' && !identity.allowedRoots.some(root => canonicalRoot === root || canonicalRoot.startsWith(root.replace(/\/$/, '') + '/')))) throw new Error('La identidad Crow no permite este proyecto.')
  return { actorId: identity.id, root: canonicalRoot }
}

async function refreshERPProjects(): Promise<void> {
  // Keep local project suggestions available offline; dispatch reauthorizes the
  // selected host and project immediately before any remote operation.
  erpProjects = store.snapshot().projects.map(project => {
    let repository: string | undefined
    try { const parsed = project.gitlabUrl ? new URL(project.gitlabUrl) : undefined; repository = parsed ? `${parsed.hostname}${parsed.pathname.replace(/\.git$/i, '')}`.slice(0, 240) : undefined } catch { /* Ignore malformed legacy metadata. */ }
    return { id: project.id, name: project.name, hostId: project.hostId, hostConnected: connections.get(project.hostId)?.status() === 'connected', summary: project.summary?.slice(0, 1000), tags: project.tags?.slice(0, 12), repository, repositoryReadable: project.allowGitLabRead === true }
  })
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
  const result = await connection(job.hostId).api<{ sessionId?: string; session?: SessionInfo; state?: string }>('POST', '/api/task-dispatch', { jobId: job.jobId, agent: job.agent, root: job.root, initialPrompt: job.initialPrompt })
  const sessionId = result.sessionId || result.session?.id
  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Entrega incierta: revisá la terminal antes de continuar.')
  return { sessionId }
}

let erpMetadataQueue: Promise<unknown> = Promise.resolve()
function erpMetadataOperation<T>(action: () => T | Promise<T>): Promise<T> {
  const next = erpMetadataQueue.catch(() => undefined).then(async () => { await refreshERPProjects(); return action() })
  erpMetadataQueue = next.then(() => undefined, () => undefined)
  return next
}
async function readERPHostTerminals(hostId: string): Promise<ERPTerminalCatalogue> {
  const generation = accessGeneration, current = connection(hostId)
  const identity = async (): Promise<Awaited<ReturnType<Connection['accessIdentity']>>> => {
    if (current.status() !== 'connected') throw new Error('Host sin conexión.')
    const status = await current.accessStatus(), actor = await current.accessIdentity()
    if (!status.enabled && actor.role === 'legacy') return actor
    if ((!status.enabled && actor.role !== 'installation') || actor.role === 'legacy' || actor.revoked) throw new Error('Identidad Crow no válida.')
    return actor
  }
  const before = await identity(), sessions = await current.api<SessionInfo[]>('GET', '/api/sessions'), actor = await identity()
  if (generation !== accessGeneration || connection(hostId) !== current || JSON.stringify(before) !== JSON.stringify(actor)) throw new Error('Cambió la identidad de Crow; consultá nuevamente.')
  const saved = store.snapshot(), projects = saved.projects.filter(project => project.hostId === hostId), hostName = saved.hosts.find(host => host.id === hostId)?.name || hostId
  const actorId = actor.role === 'legacy' ? `legacy:${hostId}` : actor.id, warnings: string[] = [], terminals: ERPTerminalCandidate[] = []
  for (const session of sessions) {
    if (session.state !== 'running' || !(session.ownerId === actorId || (actor.role === 'legacy' && !session.ownerId))) continue
    const matching = projects.filter(project => project.root === session.root && project.root.startsWith('/') && posix.normalize(project.root) === project.root)
    if (matching.length > 1) { warnings.push(`${hostName}: varios proyectos comparten la misma raíz; no se adivina la asociación.`); continue }
    const project = matching[0]
    if (!project || (actor.role !== 'legacy' && actor.role !== 'installation' && !actor.allowedRoots.some(root => project.root === root || project.root.startsWith(root.replace(/\/$/, '') + '/')))) continue
    terminals.push({ sessionId: session.id, projectId: project.id, hostId, projectName: project.name, hostName, name: saved.sessionNames[`${hostId}:${session.id}`]?.trim() || session.agent, agent: session.agent, canSubmit: !session.readOnly && session.mode === 'normal' && (session.agent === 'claude' || session.agent === 'codex') && session.hooksActive === true && (session.agentState === 'waiting' || session.agentState === 'completed') })
  }
  return { terminals, warnings: [...new Set(warnings)] }
}
async function erpTerminalCatalogue(): Promise<ERPTerminalCatalogue> {
  const generation = accessGeneration, saved = store.snapshot(), hostIds = [...new Set(saved.projects.map(project => project.hostId))]
  const results = await Promise.all(hostIds.map(async hostId => {
    const hostName = saved.hosts.find(host => host.id === hostId)?.name || hostId
    if (connections.get(hostId)?.status() !== 'connected') return { terminals: [], warnings: [`${hostName}: sin conexión.`] }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([readERPHostTerminals(hostId), new Promise<ERPTerminalCatalogue>((_, reject) => { timer = setTimeout(() => reject(new Error('Host timeout')), 2000) })])
    } catch { return { terminals: [], warnings: [`${hostName}: no disponible o sin permisos; las demás terminales siguen disponibles.`] } }
    finally { if (timer) clearTimeout(timer) }
  }))
  if (generation !== accessGeneration) throw new Error('Cambió la identidad de Crow; consultá nuevamente.')
  return { terminals: results.flatMap(result => result.terminals), warnings: results.flatMap(result => result.warnings) }
}
async function resolveERPTerminal(input: ERPExistingTerminalInput): Promise<ERPTerminalCandidate> {
  if (!input || typeof input.hostId !== 'string' || typeof input.sessionId !== 'string') throw new Error('Terminal no permitida o no disponible.')
  const result = await readERPHostTerminals(input.hostId)
  const terminal = result.terminals.find(item => item.hostId === input.hostId && item.sessionId === input.sessionId)
  if (!terminal) throw new Error('Terminal no permitida o no disponible.')
  return terminal
}

async function erpTerminals(projectId: string, hostId: string, includeClosed = false): Promise<ERPTerminalCandidate[]> {
  const generation = accessGeneration, current = connection(hostId)
  const authorized = await authorizeERPProject(projectId, hostId)
  const sessions = await current.api<SessionInfo[]>('GET', '/api/sessions')
  const actor = await authorizeERPProject(projectId, hostId)
  if (generation !== accessGeneration || connection(hostId) !== current || actor.actorId !== authorized.actorId || actor.root !== authorized.root) throw new Error('Cambió la identidad de Crow; consultá nuevamente.')
  const names = store.snapshot().sessionNames
  return sessions.filter(session => session.root === actor.root && (session.ownerId === actor.actorId || (actor.actorId === `legacy:${hostId}` && !session.ownerId)) && (includeClosed || session.state === 'running')).map(session => ({ sessionId: session.id, projectId, hostId, name: names[`${hostId}:${session.id}`]?.trim() || session.agent, agent: session.agent, canSubmit: !session.readOnly && session.mode === 'normal' && (session.agent === 'claude' || session.agent === 'codex') && session.hooksActive === true && (session.agentState === 'waiting' || session.agentState === 'completed') }))
}
async function validateERPTerminal(target: ERPTerminalTarget, expected?: { actorId: string; root: string; agent: string }, includeClosed = false): Promise<void> {
  const terminal = (await erpTerminals(target.projectId, target.hostId, includeClosed)).find(item => item.sessionId === target.sessionId)
  if (!terminal || (expected && terminal.agent !== expected.agent)) throw new Error('Terminal no permitida o no disponible.')
  const actor = await authorizeERPProject(target.projectId, target.hostId)
  if (expected && (actor.actorId !== expected.actorId || actor.root !== expected.root)) throw new Error('Cambió la identidad de Crow; autorizá nuevamente.')
}
async function submitERPTask(job: ERPDispatchJob): Promise<{ sessionId: string; status: string }> {
  const target = { projectId: job.projectId, hostId: job.hostId, sessionId: job.sessionId! }
  await validateERPTerminal(target, job)
  const result = await connection(job.hostId).api<{ requestId: string; sessionId: string; status: string }>('POST', `/api/sessions/${encodeURIComponent(target.sessionId)}/chat/submit`, { requestId: job.jobId, text: job.initialPrompt })
  if (result.requestId !== job.jobId || result.sessionId !== target.sessionId || !['accepted', 'written', 'pending', 'uncertain', 'rejected'].includes(result.status)) throw new Error('Entrega incierta; verificá la terminal.')
  return { sessionId: target.sessionId, status: result.status }
}
async function erpSubmissionStatus(target: ERPDispatchTarget, jobId: string): Promise<{ status: string }> {
  const generation = accessGeneration, current = connection(target.hostId)
  await validateERPTerminal(target, target, true)
  const result = await connection(target.hostId).api<{ requestId: string; sessionId: string; status: string }>('GET', `/api/sessions/${encodeURIComponent(target.sessionId)}/chat/submit?requestId=${encodeURIComponent(jobId)}`)
  if (result.requestId !== jobId || result.sessionId !== target.sessionId || !['accepted', 'written', 'pending', 'uncertain', 'rejected', 'unknown'].includes(result.status)) throw new Error('No se pudo verificar la entrega.')
  await validateERPTerminal(target, target, true)
  if (generation !== accessGeneration || connection(target.hostId) !== current) throw new Error('Cambió la identidad de Crow; consultá nuevamente.')
  return { status: result.status }
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

function invalidateMobileHost(hostId: string): void {
  mobileActorRoots.delete(hostId)
  mobileHostGenerations.set(hostId, (mobileHostGenerations.get(hostId) || 0) + 1)
  mobile?.invalidateHost(hostId)
}
function suspendMobileHost(hostId: string): void {
  mobileActorRoots.delete(hostId)
  mobile?.suspendHost(hostId)
}

async function mobileAuthSnapshot(hostId: string): Promise<MobileActorBinding> {
  const host = store.host(hostId), current = connections.get(hostId)
  if (!host) throw new MobileAuthorizationChangedError('Host no configurado.')
  if (current?.status() !== 'connected') throw new MobileHostUnavailableError('Conectá el host en Windows antes de vincular Android.')
  const revision = mobileHostGenerations.get(hostId) || 0
  const accessRevision = accessGeneration
  let status: Awaited<ReturnType<Connection['accessStatus']>>, identity: Awaited<ReturnType<Connection['accessIdentity']>>
  try {
    const installation = current.installationIdentity?.()
    if (installation) { status = { enabled: false, credentialRequired: false, version: 1 }; identity = installation }
    else { status = await current.accessStatus(); identity = await current.accessIdentity() }
  }
  catch (error) {
    if ([401, 403, 404].includes((error as { status?: number })?.status || 0)) throw new MobileAuthorizationChangedError('La identidad Crow fue rechazada o el servicio ya no admite acceso individual.')
    throw new MobileHostUnavailableError('No se pudo comprobar la identidad del host. El acceso está pausado.')
  }
  if (revision !== (mobileHostGenerations.get(hostId) || 0) || accessRevision !== accessGeneration || connections.get(hostId) !== current) throw new MobileAuthorizationChangedError('La identidad cambió. Generá otra invitación.')
  if (current.status() !== 'connected') throw new MobileHostUnavailableError('Conectá el host en Windows antes de vincular Android.')
  if ((!status.enabled && identity.role !== 'installation') || identity.role === 'legacy') throw new MobileAuthorizationChangedError('El host no admite identidad automática. Actualizá Crow en el servidor y volvé a conectar.')
  if (identity.revoked || !identity.id || !Array.isArray(identity.allowedRoots)) throw new MobileAuthorizationChangedError('La identidad Crow no está autorizada.')
  const principalRoots = identity.allowedRoots.filter(root => typeof root === 'string' && root.startsWith('/') && posix.normalize(root) === root)
  const allowedRoots = [...new Set(store.snapshot().projects.filter(project => project.hostId === hostId && project.root.startsWith('/') && posix.normalize(project.root) === project.root && (identity.role === 'admin' || identity.role === 'installation' || principalRoots.some(root => project.root === root || project.root.startsWith(root.replace(/\/$/, '') + '/')))).map(project => project.root))]
  if (!allowedRoots.length) throw new MobileAuthorizationChangedError('La identidad Crow no tiene proyectos permitidos.')
  mobileActorRoots.set(hostId, allowedRoots)
  return { actorId: identity.id, generation: JSON.stringify([mobile?.hostAuthorizationEpoch?.(hostId) ?? revision, host.target, host.port, host.remotePort, host.identity || '']), allowedRoots, operateOthers: identity.role === 'admin' && identity.operateOthers === true, role: identity.role }
}

function mobileWorkspaceSnapshot(): SavedState {
  const saved = store.snapshot()
  const projects = saved.projects.filter(project => connections.get(project.hostId)?.status() === 'connected' && mobileActorRoots.get(project.hostId)?.includes(project.root))
  const hosts = saved.hosts.filter(host => projects.some(project => project.hostId === host.id))
  const visibleHostIds = new Set(hosts.map(host => host.id))
  const sessionNames = Object.fromEntries(Object.entries(saved.sessionNames).filter(([key]) => {
    const separator = key.indexOf(':')
    return separator > 0 && visibleHostIds.has(key.slice(0, separator))
  }))
  return { ...saved, hosts, projects, notices: [], sessionNames, tabs: [], activeTabs: {}, eventCursors: {} }
}

async function refreshMobileWorkspace(): Promise<void> {
  await Promise.all(store.snapshot().hosts.map(async host => {
    try { await mobileAuthSnapshot(host.id) } catch { mobileActorRoots.delete(host.id) }
  }))
}

function mobileCachedQuotas(): MobileQuota[] {
  const date = (value: number | undefined): string | null => value !== undefined && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null
  return accountUsage.list().map((account, index) => ({ id: `${account.provider}:${index + 1}`, label: `${account.provider === 'claude' ? 'Claude' : 'Codex'} ${index + 1}`, provider: account.provider, state: account.status,
    sampledAt: date(account.updatedAt),
    windows: account.windows.map((item, windowIndex) => ({ label: item.windowMinutes && Number.isFinite(item.windowMinutes) ? `${item.windowMinutes} min` : `Ventana ${windowIndex + 1}`, usedPercent: Number.isFinite(item.usedPercent) ? Math.max(0, Math.min(100, item.usedPercent)) : null,
      resetsAt: date(item.resetsAt) })) }))
}

function mobileCachedNotices(): MobileNotice[] {
  return store.snapshot().notices.map(({ id, hostId, sessionId, kind, at, requiresAttention }) => ({ id, hostId, sessionId, kind, at, requiresAttention }))
}

function clearHostIdentityCaches(hostId: string): void {
  accessGeneration++
  // Paired mobile/MCP clients must not silently inherit a replacement identity.
  invalidateMobileHost(hostId)
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
      if (identity.role === 'admin' || identity.role === 'installation' || identity.role === 'legacy') { allowedHosts.add(hostId); return }
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
  handle('crow:access-enable', (hostId: string, label: string) => erpOperation(async () => {
    const prefix = `${hostId}:`
    const namedSessions = Object.entries(store.snapshot().sessionNames).filter(([key, name]) => key.startsWith(prefix) && name.trim()).map(([key, name]) => [key.slice(prefix.length), name] as const)
    clearHostIdentityCaches(hostId)
    try {
      const result = await connection(hostId).enableAccess(label)
      clearHostIdentityCaches(hostId)
      let sessions: SessionInfo[] = []
      try { sessions = await connection(hostId).api<SessionInfo[]>('GET', '/api/sessions') } catch { /* Access is enabled; preserve names even if listing needs a retry. */ }
      let claimedNamedSessions = 0
      for (const [sessionId, name] of namedSessions) {
        const session = sessions.find(item => item.id === sessionId)
        if (session && !session.ownerId) {
          try { await connection(hostId).assignSessionOwner(sessionId, result.principal.id); claimedNamedSessions++ } catch { /* Keep the name; owner can be assigned manually. */ }
        }
        store.renameSession(hostId, sessionId, name)
      }
      return { principal: result.principal, credential: '', claimedNamedSessions }
    } catch (error) {
      for (const [sessionId, name] of namedSessions) store.renameSession(hostId, sessionId, name)
      throw error
    }
  }))
  handle('crow:access-import', (hostId: string, credential: string) => erpOperation(async () => { clearHostIdentityCaches(hostId); await connection(hostId).setAccessCredential(credential); clearHostIdentityCaches(hostId) }))
  handle('crow:access-users', (hostId: string) => connection(hostId).listAccessUsers())
  handle('crow:access-create-user', (hostId: string, input: CrowAccessUserInput) => connection(hostId).createAccessUser(input))
  handle('crow:access-revoke-user', (hostId: string, id: string) => connection(hostId).revokeAccessUser(id))
  handle('crow:access-assign-session', (hostId: string, sessionId: string, ownerId: string) => connection(hostId).assignSessionOwner(sessionId, ownerId))
  handle('crow:erp-snapshot', () => erpTasks.snapshot())
  handle('crow:erp-projects', async () => { await refreshERPProjects(); return [...erpProjects] })
  handle('crow:erp-save', (input: ERPConnectionInput) => erpOperation(() => erpTasks.saveConnection(input)))
  handle('crow:erp-test', () => erpOperation(() => erpTasks.testConnection()))
  handle('crow:erp-sync', async () => { await refreshERPProjects(); return erpTasks.sync() })
  handle('crow:erp-detail', (taskKey: string) => erpOperation(() => erpTasks.loadDetail(taskKey)))
  handle('crow:erp-link', (erpProject: string, projectId: string) => erpOperation(() => erpTasks.linkProject(erpProject, projectId)))
  handle('crow:erp-classify', (taskKey: string, repositoryContext?: GitLabRepositoryContext[]) => erpOperation(() => erpTasks.classify(taskKey, repositoryContext)))
  handle('crow:erp-assign', (taskKey: string, projectId: string) => erpOperation(() => erpTasks.assign(taskKey, projectId)))
  handle('crow:erp-terminal-catalogue', () => erpTerminalCatalogue())
  handle('crow:erp-terminals', (projectId: string, hostId: string) => erpOperation(() => erpTasks.terminals(projectId, hostId)))
  handle('crow:erp-assign-terminal', (key: string, target: ERPExistingTerminalInput) => erpMetadataOperation(() => erpTasks.assignTerminal(key, target)))
  handle('crow:erp-terminal-view', (key: string, previous?: boolean) => erpMetadataOperation(() => erpTasks.terminalForView(key, previous)))
  handle('crow:erp-reconcile', (key: string) => erpOperation(() => erpTasks.reconcile(key)))
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
  handle('crow:connection-diagnostics-export', async (hostId: string) => {
    if (!window) return { canceled: true }
    if (!store.host(hostId)) throw new Error('Host desconocido.')
    const result = await dialog.showSaveDialog(window, { title: 'Exportar diagnóstico seguro de conexión', defaultPath: join(app.getPath('downloads'), `crow-conexion-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'JSON de diagnóstico', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, connectionDiagnostics.exportJSON(hostId), { encoding: 'utf8', mode: 0o600 })
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
    if (host.id) invalidateMobileHost(host.id)
    if (host.id) for (const project of store.snapshot().projects.filter(item => item.hostId === host.id)) gitLabTokens?.remove(project.id)
    if (host.id) { connections.get(host.id)?.stop(); connections.delete(host.id) }
    if (host.id && store.host(host.id)?.identity !== host.identity) vault.forget(host.id)
    return store.saveHost(host)
  })
  handle('crow:remove-host', (id: string) => {
    for (const project of store.snapshot().projects.filter(item => item.hostId === id)) gitLabTokens.remove(project.id)
    invalidateMobileHost(id)
    connections.get(id)?.stop()
    connections.delete(id)
    vault.forget(id)
    return store.removeHost(id)
  })
  handle('crow:save-project', (project: ProjectInput) => {
    const previous = project.id ? store.project(project.id) : undefined
    const saved = store.saveProject(project)
    const stored = saved.projects.find(item => item.id === project.id) || saved.projects.find(item => item.name === project.name.trim() && item.hostId === project.hostId && item.root === (project.root.replace(/\/$/, '') || '/'))
    if (stored) {
      if (!stored.gitlabUrl || !stored.allowGitLabRead || (previous?.gitlabUrl && previous.gitlabUrl !== stored.gitlabUrl)) gitLabTokens.remove(stored.id)
      if (project.gitlabToken?.trim()) {
        if (!stored.gitlabUrl || !stored.allowGitLabRead) throw new Error('Activá el permiso de lectura GitLab antes de guardar el token.')
        gitLabTokens.save(stored.id, project.gitlabToken)
      }
    }
    return saved
  })
  handle('crow:open-project-repository', (projectId: string) => {
    const url = store.project(projectId)?.gitlabUrl
    if (!url) throw new Error('Este proyecto no tiene un repositorio GitLab vinculado.')
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) throw new Error('La URL GitLab guardada no es válida.')
    return shell.openExternal(url)
  })
  handle('crow:list-gitlab-project-files', async (projectId: string) => {
    const project = store.project(projectId)
    if (!project?.allowGitLabRead || !project.gitlabUrl) throw new Error('Primero habilitá el permiso de lectura GitLab en la configuración del proyecto.')
    return listGitLabProjectFiles(project, gitLabTokens.get(project.id))
  })
  handle('crow:read-gitlab-project-files', async (projectId: string, files: string[]) => {
    const project = store.project(projectId)
    if (!project?.allowGitLabRead || !project.gitlabUrl) throw new Error('Primero habilitá el permiso de lectura GitLab en la configuración del proyecto.')
    return readGitLabProjectFiles(project, files, gitLabTokens.get(project.id))
  })
  handle('crow:remove-project', (id: string) => { gitLabTokens.remove(id); return store.removeProject(id) })
  handle('crow:save-workspace', (tabs: WorkspaceTab[], activeTabs: Record<string, string>, selectedProjectId: string) => store.saveWorkspace(tabs, activeTabs, selectedProjectId))
  handle('crow:connect', (hostId: string) => connection(hostId).connect())
  handle('crow:submit-passphrase', (hostId: string, passphrase: string) => connection(hostId).submitPassphrase(passphrase))
  handle('crow:status', (hostId: string) => connection(hostId).status())
  handle('crow:notice-read', (id: string) => store.markNoticeRead(id))
  handle('crow:rename-session', (hostId: string, sessionId: string, name: string) => terminalMetadataOperation(hostId, sessionId, async () => {
    const sessions = await connection(hostId).api<SessionInfo[]>('GET', '/api/sessions')
    const session = sessions.find(item => item.id === sessionId)
    if (!session || (session.readOnly && session.ownerId)) throw new Error('Terminal no permitida para renombrar.')
    if (!session.ownerId && session.readOnly) {
      const identity = await connection(hostId).accessIdentity()
      if ((identity.role !== 'admin' && identity.role !== 'installation') || !identity.id) throw new Error('Terminal no permitida para renombrar.')
      await connection(hostId).assignSessionOwner(sessionId, identity.id)
    }
    const project = store.snapshot().projects.find(item => item.hostId === hostId && item.root === session.root)
    if (session.claudeConversationId) {
      if (!project) throw new Error('La conversación no pertenece a un proyecto configurado.')
      await claudeConversations.preserveTerminalName(hostId, project.id, session, name)
    }
    const renamed = store.renameSession(hostId, sessionId, name)
    // Keep the host-anchored Android view in sync without delaying the local rename.
    const saved = store.snapshot(), host = saved.hosts.find(item => item.id === hostId)
    const projects = saved.projects.filter(item => item.hostId === hostId && item.root === session.root).map(({ id, name, root }) => ({ id, name, root }))
    if (host && projects.length) {
      const prefix = `${hostId}:`
      const sessionNames = Object.fromEntries(Object.entries(saved.sessionNames).filter(([key, value]) => key.startsWith(prefix) && value.trim()).map(([key, value]) => [key.slice(prefix.length), value]))
      void connection(hostId).api('POST', '/api/mobile/config', { hostId, hostName: host.name, projects, sessionNames }).catch(() => { /* Best effort; the Windows alias stays saved. */ })
    }
    return renamed
  }))
  handle('crow:sessions', (hostId: string) => connection(hostId).api<SessionInfo[]>('GET', '/api/sessions'))
  handle('crow:claude-conversations', (hostId: string, projectId: string) => claudeConversations.list(hostId, projectId))
  handle('crow:resume-claude-conversation', (hostId: string, projectId: string, id: string, requestId: string) => claudeConversations.resume(hostId, projectId, id, requestId))
  handle('crow:forget-claude-conversation', (hostId: string, projectId: string, id: string) => claudeConversations.forget(hostId, projectId, id))
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
  handle('crow:mobile-start', (input: string | MobileStartInput) => erpOperation(async () => { await refreshMobileWorkspace(); return mobile.start(input) }))
  handle('crow:mobile-stop', () => mobile.stop())
  handle('crow:mobile-invite', (input: MobileEnrollmentInput) => erpOperation(async () => {
    await refreshMobileWorkspace()
    if (!mobile.status().running || mobile.status().relayUrl !== 'wss://crow.frabubu.com/v1/tunnel' || mobile.status().remoteProvider) {
      const address = mobileAddresses()[0]
      if (!address) throw new Error('Windows necesita una IPv4 privada para iniciar el gateway móvil.')
      await mobile.start({ address, relayUrl: 'wss://crow.frabubu.com/v1/tunnel' })
    }
    const saved = store.snapshot()
    const selected = saved.projects.filter(project => input.projectIds.includes(project.id))
    const hosts = saved.hosts.filter(host => selected.some(project => project.hostId === host.id))
    if (!hosts.length) throw new Error('No hay proyectos para vincular.')
    const hostInvites: Array<{ hostId: string; hostName: string; enrollment: unknown }> = []
    const skippedHosts: Array<{ name: string; reason: string }> = []
    for (const host of hosts) {
      if (connection(host.id).status() !== 'connected') {
        skippedHosts.push({ name: host.name, reason: 'sin conexión' })
        continue
      }
      if (hostInvites.length >= 15) {
        skippedHosts.push({ name: host.name, reason: 'límite de 15 hosts por QR' })
        continue
      }
      const projects = selected.filter(project => project.hostId === host.id).map(project => ({ id: project.id, name: project.name, root: project.root }))
      try {
        const prefix = `${host.id}:`
        const sessionNames = Object.fromEntries(Object.entries(saved.sessionNames).filter(([key, value]) => key.startsWith(prefix) && value.trim()).map(([key, value]) => [key.slice(prefix.length), value]))
        await connection(host.id).api('POST', '/api/mobile/config', { hostId: host.id, hostName: host.name, projects, sessionNames })
        const enrollment = await connection(host.id).api('POST', '/api/mobile/invite')
        hostInvites.push({ hostId: host.id, hostName: host.name, enrollment })
      } catch (error) {
        const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
        skippedHosts.push({ name: host.name, reason: status === 404 ? 'servicio desactualizado' : status === 403 ? 'acceso individual o permisos pendientes' : 'servicio no disponible' })
      }
    }
    if (!hostInvites.length) throw new Error(`Ningún host seleccionado está listo para generar el QR. ${skippedHosts.map(host => `${host.name}: ${host.reason}`).join('; ')}.`)
    const readyHostIds = new Set(hostInvites.map(host => host.hostId))
    const invite = await mobile.invite({ ...input, projectIds: selected.filter(project => readyHostIds.has(project.hostId)).map(project => project.id) })
    const bundle = { version: 3, enrollments: [{ hostId: 'windows', hostName: 'Crow Windows', enrollment: invite }, ...hostInvites] }
    const bundleText = JSON.stringify(bundle)
    const compressed = `crow3:${gzipSync(Buffer.from(bundleText, 'utf8')).toString('base64url')}`
    const qrPayload = Buffer.byteLength(compressed, 'utf8') < Buffer.byteLength(bundleText, 'utf8') ? compressed : bundleText
    const qrModuleCount = QRCode.create(qrPayload, { errorCorrectionLevel: 'L' }).modules.size
    // Fixed module scale and four-module quiet zone keep each native PNG module crisp.
    const qrDataUrl = await QRCode.toDataURL(qrPayload, { scale: 6, margin: 4, errorCorrectionLevel: 'L' })
    const enrollment = { ...invite, endpoints: invite.endpoints.map(({ proxyAuth: _secret, ...endpoint }) => endpoint) }
    return { enrollment, qrDataUrl, qrModuleCount, hostCount: hostInvites.length, skippedHosts }
  }))
  handle('crow:mobile-revoke', (deviceId: string) => { mobile.revoke(deviceId); return mobile.status() })
  handle('crow:hook-settings', (hostId: string) => connection(hostId).api<{ enabled: boolean }>('GET', '/api/hooks'))
  handle('crow:set-hook-settings', (hostId: string, enabled: boolean) => connection(hostId).api<{ enabled: boolean }>('PUT', '/api/hooks', { enabled }))
  handle('crow:start-session', (hostId: string, projectId: string, agent: Agent, mode: Mode) => {
    const project = store.project(projectId)
    if (!project || project.hostId !== hostId) throw new Error('Proyecto desconocido.')
    return connection(hostId).api<SessionInfo>('POST', '/api/sessions', { agent, mode, root: project.root })
  })
  handle('crow:delete-session', (hostId: string, sessionId: string) => terminalMetadataOperation(hostId, sessionId, async () => {
    if (!/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Sesión inválida.')
    const remote = connection(hostId)
    const sessions = await remote.api<SessionInfo[]>('GET', '/api/sessions')
    const session = sessions.find(item => item.id === sessionId)
    if (!session) {
      terminalCheckpoints.remove(hostId, sessionId)
      return store.removeSession(hostId, sessionId)
    }
    if (session.readOnly) {
      if (session.ownerId) throw new Error('Terminal no permitida para eliminar.')
      const identity = await remote.accessIdentity()
      if (identity.role !== 'admin' || !identity.id) throw new Error('Solo un administrador puede reclamar y eliminar una terminal anterior sin propietario.')
      await remote.assignSessionOwner(sessionId, identity.id)
    }
    if (session.claudeConversationId) {
      const project = store.snapshot().projects.find(item => item.hostId === hostId && item.root === session.root)
      // Keep the durable conversation name before removeSession drops its PTY alias.
      // Removing a project must not make its own orphan terminal undeletable.
      if (project) await claudeConversations.preserveTerminalName(hostId, project.id, session)
    }
    await remote.api('DELETE', `/api/sessions/${sessionId}`)
    terminalCheckpoints.remove(hostId, sessionId)
    return store.removeSession(hostId, sessionId)
  }))
  handle('crow:wake-session', (hostId: string, sessionId: string) => {
    if (!/^[0-9a-f]{32}$/.test(sessionId)) throw new Error('Sesión inválida.')
    return connection(hostId).api<SessionInfo>('POST', `/api/sessions/${sessionId}/wake`)
  })
  handle('crow:attach', async (hostId: string, sessionId: string, from: number, id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Suscripción inválida.')
    await connection(hostId).attach(id, sessionId, from, (frame) => send('crow:terminal-frame', { id, frame }))
    return id
  })
  handle('crow:terminal-checkpoint-load', (hostId: string, sessionId: string) => terminalCheckpoints.load(hostId, sessionId))
  handle('crow:terminal-checkpoint-save', (hostId: string, sessionId: string, checkpoint: { seq: number; state: string; viewportY?: number }) => terminalCheckpoints.save(hostId, sessionId, checkpoint))
  handle('crow:terminal-checkpoint-remove', (hostId: string, sessionId: string) => terminalCheckpoints.remove(hostId, sessionId))
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
    ...workspaceWindowPlacement(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea),
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
  claudeConversations = new ClaudeConversationService({ project: id => store.project(id), connection, generation: () => accessGeneration, authorize: authorizeERPProject, name: (hostId, sessionId) => store.sessionName(hostId, sessionId), rename: (hostId, sessionId, name) => store.renameSession(hostId, sessionId, name) })
  connectionDiagnostics = new ConnectionDiagnosticsStore(app.getPath('userData'))
  terminalCheckpoints = new TerminalCheckpointStore(app.getPath('userData'), safeStorage)
  accountUsage = new AccountUsageService(app.getPath('userData'), createAccountUsageAdapters())
  alertSoundStore = new AlertSoundStore(app.getPath('userData'))
  alertAISettings = new AlertAISettingsStore(app.getPath('userData'), safeStorage)
  gitLabTokens = new GitLabTokenStore(app.getPath('userData'), safeStorage)
  erpTasks = new ERPTaskService(app.getPath('userData'), safeStorage, { projects: () => [...erpProjects], aiConfiguration: () => alertAISettings.configuration(), authorizeProject: authorizeERPProject, dispatch: dispatchERPTask, terminals: erpTerminals, submit: submitERPTask, submissionStatus: erpSubmissionStatus, resolveTerminal: resolveERPTerminal, authorizationGeneration: () => accessGeneration, changed: () => send('crow:erp-changed', undefined) })
  freeLLM = new FreeLLMRuntime(() => alertAISettings.snapshot(), (status) => send('crow:free-llm-status', status))
  alertAudit = new AlertAuditStore(app.getPath('userData'), safeStorage, Date.now, () => { try { return [alertAISettings.configuration().apiKey] } catch { return [] } })
  auditTimer = setInterval(() => alertAudit.prune(), 60_000)
  auditTimer.unref()
  attention = new AttentionService(store, alertAISettings, onNotice, (status) => send('crow:alert-ai-status', status), undefined, Date.now, alertAudit)
  vault = new PassphraseVault()
  mobile = new MobileGateway({ snapshot: mobileWorkspaceSnapshot, configurationSnapshot: () => store.snapshot(), connection, authSnapshot: mobileAuthSnapshot, quotas: mobileCachedQuotas, notices: mobileCachedNotices, relayClientFactory: options => new MobileRelayClient(options) })
  registerIPC()
  createWindow()
  // Refresh metadata independently; never hold app/SSH startup or execute a Task.
  void refreshERPProjects().then(() => erpTasks.startupRefresh()).catch(() => undefined)
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
  // A previously paired phone must reconnect after a normal Crow restart; the
  // Linux host routes remain independent while this process is absent.
  try {
    const address = mobileAddresses()[0]
    if (app.isPackaged && address && mobile.status().devices?.length) void mobile.start({ address, relayUrl: 'wss://crow.frabubu.com/v1/tunnel' }).catch(() => undefined)
  } catch { /* A damaged trust store leaves mobile closed, never the desktop. */ }
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { erpTasks?.stop(); accountUsage?.stop(); if (auditTimer) clearInterval(auditTimer); freeLLM?.stop(); attention?.stop(); void mobile?.stop(); void bridge?.stop(); for (const item of connections.values()) item.stop() })
