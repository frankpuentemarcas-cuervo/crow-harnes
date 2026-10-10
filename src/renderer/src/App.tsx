import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, ChevronRight, CirclePlus, Clock3, Code2, Download, Eye, EyeOff, FileCode2, Folder, FolderOpen, Globe2, HardDrive, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Plus, RefreshCw, Server, Settings2, Smartphone, TerminalSquare, Trash2, X } from 'lucide-react'
import type { Agent, AlertAISettings, AlertAIStatus, ConnectionStatus, Host, HostMetrics, Mode, Notice, Project, SavedState, SessionInfo, UpdateState, WorkspaceTab } from '../../shared/types'
import { TerminalPane } from './TerminalPane'
import { EditorPane } from './EditorPane'
import { BrowserPane } from './BrowserPane'
import { FileTree } from './FileTree'
import { decodeCompletionSound, playCompletionSound } from './completion-sound'
import { mergeNotice, NoticeSoundTracker, unreadNoticesForSession, unreadNoticesForTab, unreadSessionCountForProject } from './session-notices'
import { AlertAISettingsDialog } from './AlertAISettingsDialog'
import { AlertAuditDialog } from './AlertAuditDialog'
import { AccountUsagePanel } from './AccountUsagePanel'
import { AccountUsageDock } from './AccountUsageDock'
import { useAccountUsage } from './useAccountUsage'
import { WorkspaceMenu } from './WorkspaceMenu'
import { AccessPanel } from './AccessPanel'
import { ERPTaskKanban } from './ERPTaskKanban'
import type { NoticeSoundOutcome } from '../../shared/alert-diagnostics'
import { freeLLMStartupReady, type FreeLLMRuntimeStatus } from '../../shared/free-llm-startup'
import { hasWorkingAgent, sessionNameKey, sortSessionsByStart } from '../../shared/session-list'
import { MobileDialog } from './MobileDialog'
import { CacheWarningTracker, cacheWarningPreferences, cacheView } from '../../shared/prompt-cache'
import { CacheBadge } from './CacheBadge'
import { CacheDetailsDialog } from './CacheDetailsDialog'
import { CacheWarningSettings } from './CacheWarningSettings'
import { RenameTerminalDialog } from './RenameTerminalDialog'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'
import { HostDialog, ProjectDialog } from './WorkspaceDialogs'
import { SidebarResize } from './SidebarResize'
import { RequestVersions, sidebarWidth, visibleSidebarWidth, withoutSessionTabs } from './ui-continuity'

type Dialog = 'host' | 'project' | null
const labelFor = (agent: Agent): string => ({ shell: 'Shell', claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' })[agent]
const empty: SavedState = { hosts: [], projects: [], notices: [], sessionNames: {}, eventCursors: {}, tabs: [], activeTabs: {}, selectedProjectId: '' }
const percent = (used: number, total: number): string => total > 0 ? `${Math.round(used / total * 100)}%` : '—'
const memory = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`
const MAX_SOUND_BYTES = 5 * 1024 * 1024

function readSoundBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string' || !result.includes(',')) reject(new Error('El archivo no es válido.'))
      else resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

export function App(): React.JSX.Element {
  const confirm = useConfirm()
  const accountUsage = useAccountUsage()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [narrowNavigationOpen, setNarrowNavigationOpen] = useState(false)
  const sessionVersions = useRef(new RequestVersions())
  const operationKeys = useRef(new Set<string>())
  const [starting, setStarting] = useState(false)
  const dirtyEditors = useRef(new Set<string>())
  const busyEditors = useRef(new Set<string>())
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const [sidebarSize, setSidebarSize] = useState(() => { try { return sidebarWidth(localStorage.getItem('crow-sidebar-width')) } catch { return 280 } })
  const actualSidebarSize = visibleSidebarWidth(sidebarSize, windowWidth)
  const compactNavigation = sidebarCollapsed || windowWidth < 760 && !narrowNavigationOpen
  const [state, setState] = useState<SavedState>(empty)
  const stateRef = useRef(state)
  stateRef.current = state
  const [loaded, setLoaded] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [sessions, setSessions] = useState<Record<string, SessionInfo[]>>({})
  const [hostMetrics, setHostMetrics] = useState<Record<string, HostMetrics>>({})
  const [hostMetricErrors, setHostMetricErrors] = useState<Record<string, boolean>>({})
  const [hookSettings, setHookSettings] = useState<Record<string, boolean>>({})
  const [clockNow, setClockNow] = useState(Date.now())
  const [cachePreferences, setCachePreferences] = useState(() => {
    try { return cacheWarningPreferences(JSON.parse(localStorage.getItem('crow-cache-warnings-v1') || 'null')) }
    catch { return cacheWarningPreferences(null) }
  })
  const cacheWarnings = useRef(new CacheWarningTracker())
  const [cacheWarning, setCacheWarning] = useState<{ key: string; hostId: string; projectId: string; sessionId: string; expiresAt: string; conversationId?: string; shownAt: number } | null>(null)
  const [cacheDetail, setCacheDetail] = useState<{ hostId: string; sessionId: string } | null>(null)
  const [renamingSession, setRenamingSession] = useState<{ hostId: string; sessionId: string; initialName: string } | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const selectedProjectRef = useRef(selectedProjectId)
  selectedProjectRef.current = selectedProjectId
  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({})
  const [visitedPaneTabs, setVisitedPaneTabs] = useState<string[]>([])
  const [agent, setAgent] = useState<Agent>('claude')
  const [mode, setMode] = useState<Mode>('normal')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [editingHost, setEditingHost] = useState<Host | undefined>()
  const [editingProject, setEditingProject] = useState<Project | undefined>()
  const [projectHostId, setProjectHostId] = useState('')
  const [error, setError] = useState('')
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [alertAIOpen, setAlertAIOpen] = useState(false)
  const [alertAuditOpen, setAlertAuditOpen] = useState(false)
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [erpOpen, setERPOpen] = useState(false)
  const [accessHost, setAccessHost] = useState<Host | null>(null)
  const [alertAISettings, setAlertAISettings] = useState<AlertAISettings | null>(null)
  const [alertAIStatus, setAlertAIStatus] = useState<AlertAIStatus>({ state: 'idle', detail: 'Sin análisis todavía.' })
  const [freeLLMStatus, setFreeLLMStatus] = useState<FreeLLMRuntimeStatus | null>(null)
  const freeLLMChecked = useRef(false)
  const freeLLMLive = useRef(false)
  const noticesRef = useRef<Notice[]>([])
  const noticeSounds = useRef(new NoticeSoundTracker())
  const [soundName, setSoundName] = useState('')
  const [soundBusy, setSoundBusy] = useState(false)
  const [soundError, setSoundError] = useState('')
  const customSound = useRef<AudioBuffer | null>(null)
  const soundGeneration = useRef(0)
  const soundInput = useRef<HTMLInputElement>(null)
  const [filePanelOpen, setFilePanelOpen] = useState(true)
  const [passphraseHosts, setPassphraseHosts] = useState<string[]>([])
  const passphraseHostId = passphraseHosts[0] || ''
  const [passphrase, setPassphrase] = useState('')
  const [passphraseVisible, setPassphraseVisible] = useState(false)
  const [passphraseError, setPassphraseError] = useState('')
  const [passphraseBusy, setPassphraseBusy] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [mobileOpen, setMobileOpen] = useState(false)

  async function checkFreeLLM(): Promise<void> {
    try { const result = await window.crow.ensureFreeLLM(); if (freeLLMLive.current) setFreeLLMStatus(result) }
    catch { if (freeLLMLive.current) setFreeLLMStatus({ state: 'unavailable', detail: 'No se pudo comprobar Free LLM. Abrilo y activá su servidor local.' }) }
  }
  useEffect(() => {
    freeLLMLive.current = true
    const off = window.crow.onFreeLLMStatus(setFreeLLMStatus)
    return () => { freeLLMLive.current = false; off() }
  }, [])
  useEffect(() => {
    if (freeLLMChecked.current || !freeLLMStartupReady({ loaded, enabled: !!alertAISettings?.enabled, busy: passphraseBusy, pending: passphraseHosts.length, hostIds: state.hosts.map(host => host.id), statuses })) return
    // Let late SSH prompts/status events settle; never open another app while
    // the user is still typing a passphrase. One startup check per Crow run.
    const timer = setTimeout(() => { freeLLMChecked.current = true; void checkFreeLLM() }, 750)
    return () => clearTimeout(timer)
  }, [loaded, alertAISettings?.enabled, passphraseBusy, passphraseHosts.length, state.hosts, statuses])

  const selectedProject = state.projects.find((project) => project.id === selectedProjectId)
  const selectedHost = selectedProject && state.hosts.find((host) => host.id === selectedProject.hostId)
  const status = selectedHost ? statuses[selectedHost.id] || 'disconnected' : 'disconnected'
  const projectTabs = tabs.filter((tab) => tab.projectId === selectedProjectId)
  const activeTab = projectTabs.find((tab) => tab.id === activeTabs[selectedProjectId]) || projectTabs[0]
  const unread = state.notices.filter((notice) => !notice.read && notice.requiresAttention).length

  const sessionsByProject = useMemo(() => {
    const map: Record<string, SessionInfo[]> = {}
    for (const project of state.projects) map[project.id] = sortSessionsByStart((sessions[project.hostId] || []).filter((session) => session.root === project.root))
    return map
  }, [state.projects, sessions])
  const unreadSessionCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const project of state.projects) counts[project.id] = unreadSessionCountForProject(state.notices, project.hostId, sessionsByProject[project.id] || [])
    return counts
  }, [state.projects, state.notices, sessionsByProject])
  const workingAgentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const project of state.projects) counts[project.id] = (sessionsByProject[project.id] || []).filter((session) => session.state === 'running' && session.agentState === 'working').length
    return counts
  }, [state.projects, sessionsByProject])

  const activeSession = activeTab?.kind === 'terminal' ? (sessionsByProject[selectedProjectId] || []).find(session => session.id === activeTab.sessionId) : undefined
  const cacheDetailSession = cacheDetail ? sessions[cacheDetail.hostId]?.find(session => session.id === cacheDetail.sessionId) : undefined

  function sessionDisplayName(hostId: string, sessionId: string, agent: Agent): string {
    return state.sessionNames[sessionNameKey(hostId, sessionId)]?.trim() || labelFor(agent)
  }

  useEffect(() => { const timer = setInterval(() => setClockNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => { const resized = (): void => setWindowWidth(window.innerWidth); window.addEventListener('resize', resized); return () => window.removeEventListener('resize', resized) }, [])
  useEffect(() => { try { localStorage.setItem('crow-sidebar-width', String(sidebarSize)) } catch { /* In-memory sizing remains available. */ } }, [sidebarSize])
  useEffect(() => {
    try { localStorage.setItem('crow-cache-warnings-v1', JSON.stringify(cachePreferences)) } catch { /* Storage can be unavailable; settings still apply this run. */ }
  }, [cachePreferences])
  useEffect(() => {
    const candidates = new Map<string, { key: string; session: SessionInfo; status: ConnectionStatus; hostId: string; projectId: string }>()
    for (const project of state.projects) for (const session of sessionsByProject[project.id] || []) {
      if (session.agent !== 'claude') continue
      const key = `${project.hostId}:${session.id}`
      candidates.set(key, { key, session, status: statuses[project.hostId] || 'disconnected', hostId: project.hostId, projectId: project.id })
    }
    const due = cacheWarnings.current.collect([...candidates.values()], clockNow, cachePreferences)
    for (const item of due) {
      setCacheWarning({ key: item.key, hostId: item.hostId, projectId: item.projectId, sessionId: item.session.id, expiresAt: item.session.promptCache!.expiresAt!, conversationId: item.session.promptCache!.conversationId, shownAt: clockNow })
      void window.crow.notifyCacheExpiry(item.hostId, item.session.id).catch(() => undefined)
    }
    if (!due.length) setCacheWarning(current => {
      if (!current) return current
      const item = candidates.get(current.key)
      if (!cachePreferences.enabled || clockNow - current.shownAt >= 10000 || !item || item.session.agentState === 'working' || cacheView(item.session, item.status, clockNow).state !== 'warm' || item.session.promptCache?.expiresAt !== current.expiresAt || item.session.promptCache?.conversationId !== current.conversationId) return null
      return current
    })
  }, [state.projects, sessionsByProject, statuses, clockNow, cachePreferences])
  useEffect(() => { noticesRef.current = state.notices }, [state.notices])

  useEffect(() => {
    let live = true
    void window.crow.getAlertAISettings().then((value) => { if (live) setAlertAISettings(value) }).catch(() => undefined)
    void window.crow.getAlertAIStatus().then((value) => { if (live) setAlertAIStatus(value) }).catch(() => undefined)
    const off = window.crow.onAlertAIStatus(setAlertAIStatus)
    return () => { live = false; off() }
  }, [])

  useEffect(() => {
    if (!activeTab) return
    setVisitedPaneTabs((current) => current.includes(activeTab.id) ? current : [...current, activeTab.id])
  }, [activeTab?.id, activeTab?.kind])

  useEffect(() => {
    let live = true
    const generation = soundGeneration.current
    void window.crow.getAlertSound().then(async (saved) => {
      if (!saved) return
      const decoded = await decodeCompletionSound(saved.dataBase64)
      if (live && soundGeneration.current === generation) { customSound.current = decoded; setSoundName(saved.name) }
    }).catch((reason) => { if (live && soundGeneration.current === generation) setSoundError(`No se pudo cargar el sonido guardado: ${String(reason)}`) })
    return () => { live = false }
  }, [])

  async function refreshHooks(hostId: string): Promise<void> {
    try { const next = await window.crow.hookSettings(hostId); setHookSettings((current) => ({ ...current, [hostId]: next.enabled })) }
    catch { /* Older remote runtimes may not provide this endpoint. */ }
  }

  async function refreshSessions(hostId: string): Promise<void> {
    const version = sessionVersions.current.begin(hostId)
    try {
      const requestedAt = Date.now()
      const items = await window.crow.sessions(hostId)
      if (!sessionVersions.current.current(hostId, version)) return
      setSessions((current) => ({ ...current, [hostId]: items.map(item => item.promptCache ? { ...item, promptCache: { ...item.promptCache, receivedAt: requestedAt } } : item) }))
    } catch { /* The status indicator shows the disconnect. */ }
  }

  useEffect(() => {
    let live = true
    void window.crow.getState().then(async (saved) => {
      if (!live) return
      noticeSounds.current.restore(saved.notices)
      setState(saved)
      setTabs(saved.tabs || [])
      setActiveTabs(saved.activeTabs || {})
      setSelectedProjectId(saved.projects.some((project) => project.id === saved.selectedProjectId) ? saved.selectedProjectId : saved.projects[0]?.id || '')
      const pairs = await Promise.all(saved.hosts.map(async (host) => [host.id, await window.crow.status(host.id).catch(() => 'disconnected' as ConnectionStatus)] as const))
      if (live) {
        setStatuses(Object.fromEntries(pairs))
        setLoaded(true)
        for (const [hostId, hostStatus] of pairs) if (hostStatus === 'connected') { void refreshSessions(hostId); void refreshHooks(hostId) }
        const authHosts = pairs.filter(([, status]) => status === 'auth-required').map(([id]) => id)
        setPassphraseHosts(current => [...new Set([...current, ...authHosts])])
      }
    }).catch((reason) => { if (live) setError(String(reason)) })
    const offAccess = window.crow.onAccessChanged(hostId => {
      sessionVersions.current.begin(hostId)
      setSessions(current => ({ ...current, [hostId]: [] }))
      setState(current => ({ ...current, notices: current.notices.filter(notice => notice.hostId !== hostId), sessionNames: Object.fromEntries(Object.entries(current.sessionNames).filter(([key]) => !key.startsWith(hostId + ':'))) }))
      setTabs(current => current.filter(tab => !stateRef.current.projects.some(project => project.hostId === hostId && project.id === tab.projectId)))
      // The initial effect has no state closure; refresh authoritative cleared workspace.
      void window.crow.getState().then(saved => { if (live) { setTabs(saved.tabs); setState(saved) } }).catch(() => undefined)
      setCacheDetail(null); setCacheWarning(null); setRenamingSession(null)
      setAlertAuditOpen(false); setNoticeOpen(false)
      if (live) void refreshSessions(hostId)
    })
    const offStatus = window.crow.onStatus((hostId, next) => {
      setStatuses((current) => ({ ...current, [hostId]: next }))
      if (next === 'connected') { void refreshSessions(hostId); void refreshHooks(hostId) }
      else { setTabs(current => current.filter(tab => !stateRef.current.projects.some(project => project.hostId === hostId && project.id === tab.projectId))); sessionVersions.current.begin(hostId); setSessions(current => ({ ...current, [hostId]: [] })); setState(current => ({ ...current, notices: current.notices.filter(notice => notice.hostId !== hostId) })) }
    })
    const offNotice = window.crow.onNotice((notice) => {
      const soundOutcome = noticeSounds.current.evaluate(noticesRef.current, notice)
      const report = (outcome: NoticeSoundOutcome): void => { void window.crow.reportNoticeSound(notice.hostId, notice.id, outcome).catch(() => undefined) }
      report(soundOutcome)
      noticesRef.current = mergeNotice(noticesRef.current, notice)
      setState((current) => ({ ...current, notices: mergeNotice(current.notices, notice) }))
      if (soundOutcome === 'eligible') void playCompletionSound(customSound.current, () => report('playback-ended')).then(() => report('scheduled')).catch(() => {
        report('playback-error'); setSoundError('No se pudo reproducir la alerta. Revisá el dispositivo de audio y usá Probar sonido.')
      })
      void refreshSessions(notice.hostId)
    })
    const offPassphrase = window.crow.onPassphraseRequired((hostId) => {
      setPassphraseHosts(current => current.includes(hostId) ? current : [...current, hostId])
    })
    const offUpdate = window.crow.onUpdateState(setUpdateState)
    void window.crow.getUpdateState().then((current) => { if (live) setUpdateState(current) }).catch(() => undefined)
    return () => { live = false; offAccess(); offStatus(); offNotice(); offPassphrase(); offUpdate() }
  }, [])

  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(() => { void window.crow.saveWorkspace(tabs, activeTabs, selectedProjectId).catch(() => undefined) }, 250)
    return () => clearTimeout(timer)
  }, [tabs, activeTabs, selectedProjectId, loaded])

  useEffect(() => {
    const connectedHostIds = state.hosts.filter((host) => statuses[host.id] === 'connected').map((host) => host.id)
    if (connectedHostIds.length === 0) return
    const refreshConnectedHosts = (): void => { for (const hostId of connectedHostIds) void refreshSessions(hostId) }
    refreshConnectedHosts()
    const timer = setInterval(refreshConnectedHosts, 5000)
    return () => clearInterval(timer)
  }, [state.hosts, statuses])

  useEffect(() => {
    const connected = state.hosts.filter((host) => statuses[host.id] === 'connected')
    if (connected.length === 0) return
    let live = true
    const refresh = async (): Promise<void> => {
      const values = await Promise.all(connected.map(async (host) => {
        try { return { id: host.id, sample: await window.crow.hostMetrics(host.id), outdated: false } }
        catch (reason) { return { id: host.id, sample: null, outdated: String(reason).includes('crowd de Linux está desactualizado') } }
      }))
      if (live) {
        const samples: Record<string, HostMetrics> = {}
        for (const value of values) if (value.sample) samples[value.id] = value.sample
        setHostMetrics((current) => ({ ...current, ...samples }))
        setHostMetricErrors((current) => ({ ...current, ...Object.fromEntries(values.map((value) => [value.id, value.outdated])) }))
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10_000)
    return () => { live = false; clearInterval(timer) }
  }, [state.hosts, statuses])

  function openTab(tab: WorkspaceTab, activate = true): void {
    const existing = tabs.find((item) => item.projectId === tab.projectId && item.kind === tab.kind && (tab.kind === 'terminal' ? item.sessionId === tab.sessionId : tab.kind === 'editor' ? item.path === tab.path : true))
    const target = existing || tab
    if (!existing) setTabs((current) => current.some(item => item.id === tab.id) ? current : [...current, tab])
    if (activate) selectTab(target)
  }

  useEffect(() => window.crow.onCacheWarningClick(({ hostId, projectId, sessionId }) => {
    if (state.projects.some(project => project.id === projectId && project.hostId === hostId)) openTab({ id: crypto.randomUUID(), projectId, kind: 'terminal', sessionId })
  }), [tabs, state.projects, state.notices])

  function acknowledgeTab(tab: WorkspaceTab): void {
    void markNotices(unreadNoticesForTab(state.notices, state.projects, tab).map((notice) => notice.id))
  }

  function selectTab(tab: WorkspaceTab): void {
    setSelectedProjectId(tab.projectId)
    setActiveTabs((current) => ({ ...current, [tab.projectId]: tab.id }))
    acknowledgeTab(tab)
  }

  async function closeTab(id: string): Promise<void> {
    const tab = tabs.find((item) => item.id === id)
    if (!tab) return
    const key = `close:${id}`
    if (operationKeys.current.has(key)) return
    operationKeys.current.add(key)
    try {
      if (busyEditors.current.has(id)) { setError('Esperá a que termine el guardado antes de cerrar el archivo.'); return }
      if (dirtyEditors.current.has(id) && !await confirm({ message: '¿Cerrar este archivo y descartar los cambios sin guardar?', accept: 'Descartar y cerrar', danger: true })) return
      dirtyEditors.current.delete(id)
      setTabs(current => current.filter(item => item.id !== id))
      setActiveTabs(current => current[tab.projectId] === id ? { ...current, [tab.projectId]: '' } : current)
    } finally { operationKeys.current.delete(key) }
  }

  async function connect(hostId: string): Promise<void> {
    setError('')
    try { await window.crow.connect(hostId); await refreshSessions(hostId); await refreshHooks(hostId) }
    catch (reason) { setError(String(reason)) }
  }

  async function startSession(): Promise<void> {
    if (!selectedProject || !selectedHost) return
    if (operationKeys.current.has('start')) return
    operationKeys.current.add('start'); operationKeys.current.add(`start-host:${selectedHost.id}`); setStarting(true)
    setError('')
    try {
      if (mode === 'bypass' && !await confirm({ message: 'Bypass desactiva protecciones y aprobaciones del agente. ¿Querés iniciar esta sesión con acceso ampliado?' })) return
      const session = await window.crow.startSession(selectedHost.id, selectedProject.id, agent, mode)
      setSessions((current) => ({ ...current, [selectedHost.id]: [...(current[selectedHost.id] || []), session] }))
      openTab({ id: crypto.randomUUID(), projectId: selectedProject.id, kind: 'terminal', sessionId: session.id }, selectedProjectRef.current === selectedProject.id)
    } catch (reason) { setError(String(reason)) }
    finally { operationKeys.current.delete('start'); operationKeys.current.delete(`start-host:${selectedHost.id}`); setStarting(false) }
  }

  async function deleteSession(hostId: string, session: SessionInfo): Promise<void> {
    const key = `delete:${hostId}:${session.id}`
    if (operationKeys.current.has(key)) return
    operationKeys.current.add(key)
    setError('')
    try {
      if (!await confirm({ message: `¿Eliminar definitivamente la terminal ${sessionDisplayName(hostId, session.id, session.agent)} (${session.id.slice(0, 8)})? Se terminarán sus procesos remotos y se borrará el historial de terminal. Esta acción no se puede deshacer.`, accept: 'Eliminar terminal', danger: true })) return
      await window.crow.saveWorkspace(tabs, activeTabs, selectedProjectId)
      const saved = await window.crow.deleteSession(hostId, session.id)
      sessionVersions.current.begin(hostId)
      setState(saved)
      const projectIds = new Set(state.projects.filter(project => project.hostId === hostId).map(project => project.id))
      setTabs(current => withoutSessionTabs(current, projectIds, session.id))
      if (cacheDetail?.hostId === hostId && cacheDetail.sessionId === session.id) setCacheDetail(null)
      setSessions((current) => ({ ...current, [hostId]: (current[hostId] || []).filter((item) => item.id !== session.id) }))
    } catch (reason) { setError(String(reason)) }
    finally { operationKeys.current.delete(key) }
  }

  function renameSession(hostId: string, session: SessionInfo): void {
    if (operationKeys.current.has(`delete:${hostId}:${session.id}`)) { setError('Esta terminal se está eliminando. Esperá a que termine.'); return }
    const key = sessionNameKey(hostId, session.id)
    setRenamingSession({ hostId, sessionId: session.id, initialName: state.sessionNames[key] || '' })
  }

  async function saveHost(input: Omit<Host, 'id'> & { id?: string }): Promise<void> {
    const saved = await window.crow.saveHost(input)
    setState(saved)
    const id = input.id || saved.hosts.at(-1)?.id
    if (id) void connect(id)
    setDialog(null)
    setEditingHost(undefined)
  }

  async function toggleHooks(hostId: string, enabled: boolean): Promise<void> {
    setError('')
    const next = await window.crow.setHookSettings(hostId, enabled)
    setHookSettings((current) => ({ ...current, [hostId]: next.enabled }))
    await refreshSessions(hostId)
  }

  async function saveProject(input: Omit<Project, 'id'> & { id?: string }): Promise<void> {
    const saved = await window.crow.saveProject(input)
    setState(saved)
    setSelectedProjectId(input.id || saved.projects.at(-1)?.id || '')
    setDialog(null)
    setEditingProject(undefined)
  }

  async function markNotices(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const selected = new Set(ids)
    noticesRef.current = noticesRef.current.map((notice) => selected.has(notice.id) ? { ...notice, read: true } : notice)
    setState((current) => ({ ...current, notices: current.notices.map((notice) => selected.has(notice.id) ? { ...notice, read: true } : notice) }))
    try {
      for (const id of ids) await window.crow.markNoticeRead(id)
    } catch (reason) {
      setError(`No se pudo marcar la alerta como leída: ${String(reason)}`)
      try {
        const saved = await window.crow.getState()
        setState((current) => ({ ...current, notices: saved.notices }))
      } catch { /* Se conserva el estado visual hasta la próxima carga. */ }
    }
  }

  async function openMobile(): Promise<void> { setMobileOpen(true) }

  async function unlockHost(): Promise<void> {
    if (!passphraseHostId || !passphrase) return
    if (operationKeys.current.has('unlock')) return
    operationKeys.current.add('unlock')
    setPassphraseBusy(true)
    setPassphraseError('')
    try {
      await window.crow.submitPassphrase(passphraseHostId, passphrase)
      setPassphrase('')
      setPassphraseHosts(current => current.filter(id => id !== passphraseHostId))
      setPassphraseVisible(false)
    } catch (reason) {
      setPassphraseError(String(reason))
      setPassphrase('')
    } finally { operationKeys.current.delete('unlock'); setPassphraseBusy(false) }
  }

  async function chooseAlertSound(file?: File): Promise<void> {
    if (!file) return
    setSoundError('')
    if (!/\.(mp3|wav|ogg)$/i.test(file.name) || file.size === 0 || file.size > MAX_SOUND_BYTES) {
      setSoundError('Elegí un MP3, WAV u OGG de hasta 5 MB.')
      return
    }
    soundGeneration.current += 1
    setSoundBusy(true)
    try {
      const dataBase64 = await readSoundBase64(file)
      const decoded = await decodeCompletionSound(dataBase64)
      await window.crow.saveAlertSound({ name: file.name, dataBase64 })
      customSound.current = decoded
      setSoundName(file.name)
      void playCompletionSound(decoded).catch((reason) => setSoundError(`Se guardó, pero no se pudo reproducir: ${String(reason)}`))
    } catch (reason) {
      setSoundError(`No se pudo configurar el sonido: ${String(reason)}`)
      if (!customSound.current) {
        try {
          const saved = await window.crow.getAlertSound()
          if (saved) { customSound.current = await decodeCompletionSound(saved.dataBase64); setSoundName(saved.name) }
        } catch { /* El tono predeterminado sigue disponible. */ }
      }
    } finally { setSoundBusy(false) }
  }

  async function restoreDefaultSound(): Promise<void> {
    soundGeneration.current += 1
    setSoundBusy(true)
    setSoundError('')
    try {
      await window.crow.clearAlertSound()
      customSound.current = null
      setSoundName('')
    } catch (reason) { setSoundError(`No se pudo restaurar el sonido: ${String(reason)}`) }
    finally { setSoundBusy(false) }
  }

  return <div className="app-shell" tabIndex={-1}>
    <aside className="sidebar" style={{ width: actualSidebarSize }} hidden={compactNavigation}>
      <div className="brand"><span className="brand-mark"><Code2 size={18} /></span><span>CROW<span className="brand-soft"> HARNESS</span></span><button className="icon-button sidebar-action" title="Configuración" aria-label="Configuración" onClick={() => { setEditingHost(undefined); setDialog('host') }}><Settings2 size={16} /></button></div>
      <div className="sidebar-scroll">
        <div className="section-heading"><span>HOSTS</span><button className="icon-button" title="Agregar host" aria-label="Agregar host" onClick={() => { setEditingHost(undefined); setDialog('host') }}><Plus size={16} /></button></div>
        {state.hosts.length === 0 && <p className="sidebar-hint">Agregá un servidor para comenzar.</p>}
        {state.hosts.map((host) => <div key={host.id} className="host-group">
          <div className="host-row">
            <Server size={15} className="muted-icon" /><span className={`status-dot ${statuses[host.id] || 'disconnected'}`} title={statuses[host.id] || 'Desconectado'} />
            <span className="host-name">{host.name}</span>
            <button className="icon-button ghost-action" title="Identidad y permisos Crow" aria-label={`Acceso ${host.name}`} onClick={() => setAccessHost(host)}><Settings2 size={13} /></button>
            <button className="icon-button ghost-action" title="Conectar" aria-label={`Conectar ${host.name}`} onClick={() => void connect(host.id)}><RefreshCw size={13} /></button>
            <button className="icon-button ghost-action" title="Editar host" aria-label={`Editar ${host.name}`} onClick={() => { setEditingHost(host); setDialog('host') }}><MoreHorizontal size={15} /></button>
          </div>
          {state.projects.filter((project) => project.hostId === host.id).map((project) => {
            const workingAgents = workingAgentCounts[project.id] || 0
            const projectExpanded = selectedProjectId === project.id || hasWorkingAgent(sessionsByProject[project.id] || [])
            return <div key={project.id}>
            <button className={`project-row ${selectedProjectId === project.id ? 'selected' : ''} ${workingAgents > 0 ? 'working' : ''}`} aria-label={`${project.name}${workingAgents ? `, ${workingAgents} ${workingAgents === 1 ? 'agente trabajando' : 'agentes trabajando'}` : ''}${unreadSessionCounts[project.id] ? `, ${unreadSessionCounts[project.id]} terminales con alertas sin leer` : ''}`} onClick={() => setSelectedProjectId(project.id)}>
              {projectExpanded ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span className="project-name">{project.name}</span>
              {workingAgents > 0 && <span className="project-working-dot" title={`${workingAgents} ${workingAgents === 1 ? 'agente trabajando' : 'agentes trabajando'}`} aria-hidden="true" />}
              {unreadSessionCounts[project.id] > 0 && <span className="project-alert" title="Terminales con alertas sin leer"><Bell size={12} aria-hidden="true" /><span>{unreadSessionCounts[project.id]}</span></span>}
              <ChevronRight size={13} className={`project-chevron ${projectExpanded ? 'expanded' : ''}`} />
            </button>
            {projectExpanded && (sessionsByProject[project.id] || []).map((session) => {
              const agentWorking = session.state === 'running' && session.agentState === 'working'
              return <div key={session.id} className={`session-entry ${agentWorking ? 'agent-working' : ''}`}>
              <button className={`session-row ${agentWorking ? 'agent-working' : ''}`} title={agentWorking ? 'Agente trabajando; abrir terminal' : session.state === 'sleeping' ? 'Abrir terminal suspendida para reanudarla' : 'Abrir vista de terminal'} onClick={() => openTab({ id: crypto.randomUUID(), projectId: project.id, kind: 'terminal', sessionId: session.id })}>
                <span className={`session-state ${session.state} ${agentWorking ? 'agent-working' : ''}`} /><span className="session-name" title={`${sessionDisplayName(host.id, session.id, session.agent)} · ${session.id}`}>{sessionDisplayName(host.id, session.id, session.agent)}</span>
              </button>
              <CacheBadge session={session} status={statuses[host.id] || 'disconnected'} now={clockNow} compact onOpen={() => setCacheDetail({ hostId: host.id, sessionId: session.id })} />
              {unreadNoticesForSession(state.notices, host.id, session.id).length > 0 && <button className="session-notice" title="Abrir terminal y marcar alerta como leída" aria-label={`Abrir terminal ${sessionDisplayName(host.id, session.id, session.agent)} y marcar alerta como leída`} onClick={() => openTab({ id: crypto.randomUUID(), projectId: project.id, kind: 'terminal', sessionId: session.id })}><Bell size={14} fill="currentColor" aria-hidden="true" /></button>}
              <button disabled={session.readOnly} className="session-rename" title="Renombrar terminal" aria-label={`Renombrar terminal ${sessionDisplayName(host.id, session.id, session.agent)}`} onClick={() => void renameSession(host.id, session)}><Pencil size={13} /></button>
              <button disabled={session.readOnly} className="session-delete" title="Eliminar terminal y procesos remotos" aria-label={`Eliminar terminal ${sessionDisplayName(host.id, session.id, session.agent)}`} onClick={() => void deleteSession(host.id, session)}><Trash2 size={13} /></button>
            </div>
            })}
          </div>
          })}
          <button className="sidebar-add-project" onClick={() => { setEditingProject(undefined); setProjectHostId(host.id); setDialog('project') }}><Plus size={13} /> Agregar proyecto</button>
        </div>)}
      </div>
      <AccountUsageDock model={accountUsage} onManage={() => setAccountsOpen(true)} />
      <div className="sidebar-footer"><HardDrive size={14} /><span>Windows · Hosts Linux</span></div>
    </aside>
    {!compactNavigation && <SidebarResize width={actualSidebarSize} onChange={setSidebarSize} />}

    <div className="workspace">
      {compactNavigation && <AccountUsageDock model={accountUsage} compact onManage={() => setAccountsOpen(true)} />}
      <header className="topbar">
        <button className="icon-button navigation-toggle" title={compactNavigation ? 'Mostrar proyectos' : 'Contraer proyectos'} aria-label={compactNavigation ? 'Mostrar proyectos' : 'Contraer proyectos'} aria-expanded={!compactNavigation} onClick={() => { if (windowWidth < 760) { setSidebarCollapsed(false); setNarrowNavigationOpen(value => !value) } else setSidebarCollapsed(value => !value) }}>{compactNavigation ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
        <div className="breadcrumb"><span>{selectedHost?.name || 'Sin host'}</span><ChevronRight size={14} /><strong>{selectedProject?.name || 'Seleccioná un proyecto'}</strong><span className={`connection-pill ${status}`}>{status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Reconectando' : status === 'auth-required' ? 'Frase requerida' : 'Desconectado'}</span></div>
        <WorkspaceMenu label="Recursos de los servidores" className="host-metrics" trigger={<><Server size={14} /><span className="metric-trigger-text">{selectedHost?.name || 'Hosts'} · CPU {selectedHost && hostMetrics[selectedHost.id]?.cpuPercent != null && status === 'connected' ? `${Math.round(hostMetrics[selectedHost.id].cpuPercent!)}%` : '—'} · RAM {selectedHost && hostMetrics[selectedHost.id] && status === 'connected' ? percent(hostMetrics[selectedHost.id].memoryUsed, hostMetrics[selectedHost.id].memoryTotal) : '—'}</span><ChevronRight size={12} /></>}>
          <div className="metrics-title">Recursos · {state.hosts.length} hosts</div>
          {state.hosts.length === 0 && <p className="empty-small">Sin hosts registrados.</p>}
          {state.hosts.map((host) => {
          if (statuses[host.id] === 'connected' && hostMetricErrors[host.id]) return <div key={host.id} className="host-metric" title={`El servicio crowd de ${host.name} está desactualizado. Actualizalo y reinicialo en Linux para ver métricas y eliminar terminales.`}><span className="host-metric-name">{host.name}</span><span className="metric-outdated">Actualizar crowd Linux</span></div>
          const sample = statuses[host.id] === 'connected' ? hostMetrics[host.id] : undefined
          return <div key={host.id} className="host-metric" title={`Servidor ${host.name}: CPU, memoria, disco raíz y terminales suspendidas. La RAM suspendida es consumo estimado, no memoria liberada.`}><span className="host-metric-name">{host.name}</span><span>CPU {sample?.cpuPercent == null ? '—' : `${Math.round(sample.cpuPercent)}%`}</span><span>RAM {sample ? percent(sample.memoryUsed, sample.memoryTotal) : '—'}</span><span>DISCO {sample ? percent(sample.diskUsed, sample.diskTotal) : '—'}</span><span className="sleeping-metric" role="status" aria-atomic="true">Suspendidas {sample?.sleepingSessions ?? '—'} · RAM ≈{sample ? memory(sample.sleepingMemory || 0) : '—'}</span></div>
        })}
        </WorkspaceMenu>
        <div className="top-actions">
          {activeSession && selectedHost && <CacheBadge session={activeSession} status={status} now={clockNow} onOpen={() => setCacheDetail({ hostId: selectedHost.id, sessionId: activeSession.id })} />}
          <button className="secondary-button small-button" onClick={() => setERPOpen(true)}>Kanban ERP</button>
          <WorkspaceMenu label="Configuración e integraciones" trigger={<Settings2 size={17} />}>
            <button onClick={() => { setEditingHost(undefined); setDialog('host') }}><Server size={16} />Gestionar hosts</button>
            <button onClick={() => setAccountsOpen(true)}><Settings2 size={16} />Cuentas</button>
            <button onClick={() => void openMobile()}><Smartphone size={16} />Acceso móvil en red local</button>
            <button disabled={['checking', 'available', 'downloading', 'downloaded'].includes(updateState.status)} onClick={() => void window.crow.checkForUpdates().catch(() => undefined)}><RefreshCw size={16} />Buscar actualizaciones</button>
            <button onClick={() => setAlertAuditOpen(true)}><Eye size={16} />Diagnóstico de alertas</button>
            <button onClick={() => setAlertAIOpen(true)}><Settings2 size={16} />Configurar IA · Free LLM</button>
          </WorkspaceMenu>
          <div className="notice-container"><button className="icon-button notice-button" title="Notificaciones" aria-label="Notificaciones" onClick={() => setNoticeOpen((value) => !value)}><Bell size={17} />{unread > 0 && <span className="notice-count">{unread}</span>}</button>
             {noticeOpen && <div className="notice-popover"><div className="popover-title">Actividad de agentes<button className="sound-test" onClick={() => void playCompletionSound(customSound.current).catch((reason) => setSoundError(`No se pudo reproducir el sonido: ${String(reason)}`))}>Probar sonido</button></div><div className="sound-settings"><span className="sound-name" title={soundName || 'Tono predeterminado'}>Sonido: {soundName || 'Tono predeterminado'}</span><div className="sound-actions"><input ref={soundInput} className="sound-file-input" type="file" accept=".mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void chooseAlertSound(file) }} /><button className="sound-test" disabled={soundBusy} onClick={() => soundInput.current?.click()}>Elegir archivo</button>{(soundName || soundError) && <button className="sound-test" disabled={soundBusy} onClick={() => void restoreDefaultSound()}>Restaurar original</button>}</div><small>MP3, WAV u OGG · hasta 5 MB y 30 s</small><small>La alerta suena cuando el agente necesita tu intervención; los avisos informativos quedan sin sonido.</small><div className="alert-ai-summary"><button className="sound-test" onClick={() => setAlertAIOpen(true)}>Configurar IA · Free LLM</button><small>{alertAISettings?.enabled ? 'Clasificación por IA activada' : 'IA desactivada · reglas locales'}</small>{alertAISettings?.configurationError && <small className="ai-error" role="alert">{alertAISettings.configurationError}</small>}{alertAISettings?.enabled && <small className={alertAIStatus.state === 'error' ? 'ai-error' : ''} role="status">{alertAIStatus.detail}</small>}</div>{soundError && <small className="sound-error" role="alert">{soundError}</small>}</div><CacheWarningSettings value={cachePreferences} onChange={setCachePreferences} />{state.notices.length === 0 && <p className="empty-small">Sin notificaciones.</p>}{state.notices.slice(0, 15).map((notice) => <button key={notice.id} className={`notice-item ${notice.requiresAttention && !notice.read ? 'unread' : ''}`} onClick={() => { void markNotices([notice.id]); setNoticeOpen(false) }}><span>{notice.classification?.source === 'pending' ? 'Analizando respuesta…' : notice.classification?.decision === 'uncertain' ? 'Revisión preventiva' : notice.requiresAttention ? 'Necesita tu atención' : notice.kind === 'turn-complete' ? 'Respuesta informativa' : 'Proceso finalizado'}</span><small>{notice.classification?.detail}</small><small>{state.hosts.find((host) => host.id === notice.hostId)?.name || 'Host'} · {new Date(notice.at).toLocaleString()}</small></button>)}</div>}
          </div>
        </div>
      </header>

      {cacheWarning && <div className="cache-warning" role="status" aria-live="polite"><Clock3 size={15} aria-hidden="true" /><span>Caché Claude por vencer · {sessionDisplayName(cacheWarning.hostId, cacheWarning.sessionId, 'claude')}. La conversación se conserva.</span><button className="sound-test" onClick={() => { openTab({ id: crypto.randomUUID(), projectId: cacheWarning.projectId, kind: 'terminal', sessionId: cacheWarning.sessionId }); setCacheWarning(null) }}>Abrir terminal</button><button className="icon-button" aria-label="Descartar aviso de caché" onClick={() => setCacheWarning(null)}><X size={15} /></button></div>}

      {(updateState.status === 'available' || updateState.status === 'downloading' || updateState.status === 'downloaded' || updateState.status === 'error') && <div className={`update-banner ${updateState.status}`} role="status" aria-live="polite">
        <span className="update-message"><Download size={15} />{updateState.status === 'available' ? `Actualización ${updateState.version || ''} disponible; descargando…` : updateState.status === 'downloading' ? `Descargando actualización… ${updateState.percent ?? 0}%` : updateState.status === 'downloaded' ? `Actualización ${updateState.version || ''} lista para instalar.` : 'No se pudo buscar actualizaciones.'}</span>
        {updateState.status === 'downloading' && <progress max="100" value={updateState.percent ?? 0} aria-label="Progreso de descarga" />}
        {updateState.status === 'downloaded' && <button className="primary-button small-button" onClick={() => void window.crow.installUpdate().catch((reason) => setError(String(reason)))}>Reiniciar y actualizar</button>}
        {updateState.status === 'error' && <button className="secondary-button small-button" onClick={() => void window.crow.checkForUpdates().catch(() => undefined)}>Reintentar</button>}
      </div>}

      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Cerrar error" onClick={() => setError('')}><X size={15} /></button></div>}
      {alertAISettings?.enabled && freeLLMStatus && !['idle', 'disabled'].includes(freeLLMStatus.state) && <div className="free-llm-banner" role={freeLLMStatus.state === 'unavailable' ? 'alert' : 'status'}><span>{freeLLMStatus.detail}</span>
        {freeLLMStatus.state === 'unavailable' && <><button className="secondary-button small-button" onClick={() => void checkFreeLLM()}>Comprobar de nuevo</button><button className="secondary-button small-button" onClick={() => setAlertAIOpen(true)}>Configurar IA</button></>}
        {freeLLMStatus.state === 'available' && <button className="icon-button" aria-label="Cerrar aviso de Free LLM" onClick={() => setFreeLLMStatus(null)}><X size={15} /></button>}
      </div>}

      {selectedProject && selectedHost ? <>
        <div className="toolbar">
          <div className="path-label"><Folder size={15} /><span title={selectedProject.root}>{selectedProject.root}</span></div>
          <div className="toolbar-right">
            <button className="secondary-button files-toggle" aria-label="Mostrar archivos" aria-pressed={filePanelOpen} onClick={() => setFilePanelOpen(value => !value)}>{filePanelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}<span>Archivos</span></button>
            <select aria-label="Agente" value={agent} onChange={(event) => { const next = event.target.value as Agent; setAgent(next); if (next === 'shell') setMode('normal') }}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="agy">Antigravity</option><option value="shell">Shell</option></select>
            <select aria-label="Modo de permisos" value={mode} disabled={agent === 'shell'} onChange={(event) => setMode(event.target.value as Mode)}><option value="normal">Permisos normales</option><option value="bypass">Bypass permisos</option></select>
            <button className="primary-button" disabled={status !== 'connected' || starting} onClick={() => void startSession()}><Plus size={15} /> Terminal</button>
            <button className="secondary-button" disabled={status !== 'connected'} onClick={() => openTab({ id: crypto.randomUUID(), projectId: selectedProject.id, kind: 'browser', url: 'http://localhost:3000' })}><Globe2 size={15} /> Navegador</button>
          </div>
        </div>
        <div className="content-row">
          <main className="main-pane">
            <div className="tab-bar" role="tablist" aria-label="Pestañas del proyecto">
              {projectTabs.map((tab) => {
                const session = tab.kind === 'terminal' ? sessionsByProject[selectedProject.id]?.find((item) => item.id === tab.sessionId) : undefined
                const title = tab.kind === 'terminal' ? sessionDisplayName(selectedProject.hostId, tab.sessionId || '', session?.agent || 'shell') : tab.kind === 'browser' ? 'Navegador' : tab.path?.split('/').at(-1)
                return <div key={tab.id} className={`tab ${activeTab?.id === tab.id ? 'active' : ''}`} role="tab" aria-selected={activeTab?.id === tab.id}>
                  <button className="tab-select" onClick={() => selectTab(tab)}>{tab.kind === 'terminal' ? <TerminalSquare size={14} /> : tab.kind === 'browser' ? <Globe2 size={14} /> : <FileCode2 size={14} />}<span>{title}</span></button>
                  <button className="tab-close" title="Cerrar vista (la sesión remota sigue activa)" aria-label="Cerrar vista" onClick={() => void closeTab(tab.id)}><X size={13} /></button>
                </div>
              })}
            </div>
            <div className="pane-body">
              {!activeTab && <div className="blank-state"><div className="blank-icon"><TerminalSquare size={30} /></div><h2>Tu espacio está listo</h2><p>Abrí una terminal con un agente, explorá archivos o iniciá el navegador del servidor.</p><button className="secondary-button" disabled={status !== 'connected' || starting} onClick={() => void startSession()}><CirclePlus size={16} /> Nueva terminal</button></div>}
              {tabs.filter((tab) => tab.kind === 'terminal' && tab.sessionId && visitedPaneTabs.includes(tab.id)).map((tab) => {
                const project = state.projects.find((item) => item.id === tab.projectId)
                if (!project) return null
                const active = activeTab?.id === tab.id && selectedProjectId === tab.projectId
                return <div key={tab.id} className="terminal-tab-slot" hidden={!active} onPointerDownCapture={() => acknowledgeTab(tab)}><TerminalPane hostId={project.hostId} sessionId={tab.sessionId!} status={statuses[project.hostId] || 'disconnected'} active={active} readOnly={sessions[project.hostId]?.some(session => session.id === tab.sessionId) ? !!sessions[project.hostId]?.find(session => session.id === tab.sessionId)?.readOnly : true} /></div>
              })}
              {tabs.filter(tab => tab.kind === 'editor' && tab.path && visitedPaneTabs.includes(tab.id)).map(tab => {
                const project = state.projects.find(item => item.id === tab.projectId)
                if (!project) return null
                return <div key={tab.id} className="terminal-tab-slot" hidden={activeTab?.id !== tab.id || selectedProjectId !== tab.projectId}><EditorPane hostId={project.hostId} root={project.root} path={tab.path!} status={statuses[project.hostId] || 'disconnected'} onBusyChange={busy => { if (busy) busyEditors.current.add(tab.id); else busyEditors.current.delete(tab.id) }} onDirtyChange={dirty => { if (dirty) dirtyEditors.current.add(tab.id); else dirtyEditors.current.delete(tab.id) }} onOpenLink={target => openTab({ id: crypto.randomUUID(), projectId: project.id, kind: target.kind === 'url' ? 'browser' : 'editor', ...(target.kind === 'url' ? { url: target.value } : { path: target.value }) })} /></div>
              })}
              {tabs.filter(tab => tab.kind === 'browser' && visitedPaneTabs.includes(tab.id)).map(tab => {
                const project = state.projects.find(item => item.id === tab.projectId)
                if (!project) return null
                const active = activeTab?.id === tab.id && selectedProjectId === tab.projectId
                return <div key={tab.id} className="terminal-tab-slot" hidden={!active}><BrowserPane hostId={project.hostId} root={project.root} initialURL={tab.url || 'http://localhost:3000'} status={statuses[project.hostId] || 'disconnected'} active={active} onURL={url => setTabs(current => current.some(item => item.id === tab.id && item.url !== url) ? current.map(item => item.id === tab.id ? { ...item, url } : item) : current)} /></div>
              })}
            </div>
          </main>
          {filePanelOpen && <aside className="files-pane"><FileTree key={selectedProject.id} hostId={selectedHost.id} root={selectedProject.root} projectName={selectedProject.name} status={status} onOpen={(path) => openTab({ id: crypto.randomUUID(), projectId: selectedProject.id, kind: 'editor', path })} /></aside>}
        </div>
      </> : <div className="welcome"><div className="welcome-symbol"><Code2 size={36} /></div><h1>Un espacio para tus agentes</h1><p>Conectá un host Linux y agregá una carpeta de proyecto para empezar.</p><button className="primary-button" onClick={() => { setEditingHost(undefined); setDialog('host') }}><Plus size={16} /> Agregar host</button></div>}
      <footer className="statusbar"><span><span className={`status-dot ${status}`} /> {selectedHost?.name || 'Sin conexión'}</span><span>{selectedProject?.root || 'Crow Harness v0.1'}</span></footer>
    </div>
    {dialog === 'host' && <HostDialog host={editingHost} hostConnected={!!editingHost && statuses[editingHost.id] === 'connected'} hooksEnabled={editingHost ? hookSettings[editingHost.id] : undefined} onToggleHooks={editingHost ? (enabled) => toggleHooks(editingHost.id, enabled) : undefined} onClose={() => setDialog(null)} onSave={saveHost} onDelete={editingHost ? async () => { if (operationKeys.current.has(`start-host:${editingHost.id}`)) throw new Error('Esperá a que termine la creación de la terminal antes de quitar el host.'); if (tabs.some(tab => state.projects.some(project => project.id === tab.projectId && project.hostId === editingHost.id) && busyEditors.current.has(tab.id))) throw new Error('Esperá a que termine el guardado de archivos antes de quitar el host.'); const saved = await window.crow.removeHost(editingHost.id); sessionVersions.current.begin(editingHost.id); setState(saved); setTabs(current => current.filter(tab => saved.projects.some(project => project.id === tab.projectId))); setDialog(null); if (selectedHost?.id === editingHost.id) setSelectedProjectId(saved.projects[0]?.id || '') } : undefined} />}
    {dialog === 'project' && <ProjectDialog project={editingProject} hosts={state.hosts} defaultHostId={projectHostId || selectedHost?.id || state.hosts[0]?.id || ''} onClose={() => setDialog(null)} onSave={saveProject} />}
    {alertAIOpen && <AlertAISettingsDialog onClose={() => setAlertAIOpen(false)} onSaved={setAlertAISettings} />}
    {alertAuditOpen && <AlertAuditDialog hosts={state.hosts} sessionNames={state.sessionNames} onClose={() => setAlertAuditOpen(false)} />}
    {accountsOpen && <AccountUsagePanel onClose={() => setAccountsOpen(false)} model={accountUsage} />}
    {accessHost && <AccessPanel key={accessHost.id} host={accessHost} sessions={sessions[accessHost.id] || []} onClose={() => setAccessHost(null)} />}
    {erpOpen && <ERPTaskKanban onClose={() => setERPOpen(false)} onTerminal={(projectId, sessionId) => { setERPOpen(false); setSelectedProjectId(projectId); openTab({ id: crypto.randomUUID(), projectId, kind: "terminal", sessionId }); const project = state.projects.find(item => item.id === projectId); if (project) void refreshSessions(project.hostId) }} />}
    {cacheDetailSession && cacheDetail && <CacheDetailsDialog session={cacheDetailSession} status={statuses[cacheDetail.hostId] || 'disconnected'} now={clockNow} onClose={() => setCacheDetail(null)} />}
    {renamingSession && <RenameTerminalDialog key={sessionNameKey(renamingSession.hostId, renamingSession.sessionId)} initialName={renamingSession.initialName} onSave={async (name) => {
      setState(await window.crow.renameSession(renamingSession.hostId, renamingSession.sessionId, name))
    }} onClose={() => setRenamingSession(null)} />}
    {mobileOpen && <MobileDialog projects={state.projects} hosts={state.hosts} onClose={() => setMobileOpen(false)} />}
    {passphraseHostId && <Modal key={passphraseHostId} titleId="passphrase-title" initialFocus="input" busy={passphraseBusy} onClose={() => { setPassphraseHosts(current => current.slice(1)); setPassphrase(''); setPassphraseError(''); setPassphraseVisible(false) }}><form onSubmit={(event) => { event.preventDefault(); void unlockHost() }}>
      <div className="dialog-heading"><h2 id="passphrase-title">Desbloquear llave SSH</h2><button type="button" className="icon-button" aria-label="Cerrar" disabled={passphraseBusy} onClick={() => { setPassphraseHosts(current => current.slice(1)); setPassphrase(''); setPassphraseError(''); setPassphraseVisible(false) }}><X size={18} /></button></div>
      <p>Ingresá la frase de la llave para conectar con {state.hosts.find((host) => host.id === passphraseHostId)?.name || 'el host'}. Se recordará en este equipo hasta reiniciar Windows.</p>
      <label>Frase de la llave SSH<div className="secret-field"><input required readOnly={passphraseBusy} type={passphraseVisible ? 'text' : 'password'} value={passphrase} aria-describedby={passphraseError ? 'passphrase-error' : undefined} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" /><button type="button" className="icon-button" aria-label={passphraseVisible ? 'Ocultar frase' : 'Mostrar frase'} onClick={() => setPassphraseVisible((value) => !value)}>{passphraseVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
      {passphraseError && <div id="passphrase-error" className="inline-error" role="alert">{passphraseError}</div>}
      <div className="dialog-actions"><span /><button type="button" className="secondary-button" disabled={passphraseBusy} onClick={() => { setPassphraseHosts(current => current.slice(1)); setPassphrase(''); setPassphraseError(''); setPassphraseVisible(false) }}>Cancelar</button><button type="submit" className="primary-button" disabled={passphraseBusy || !passphrase}>{passphraseBusy ? 'Conectando…' : 'Conectar'}</button></div>
    </form></Modal>}
  </div>
}
