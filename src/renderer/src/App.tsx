import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Bell, ChevronRight, CirclePlus, Clock3, Code2, Download, Eye, EyeOff, FileCode2, Folder, FolderOpen, Globe2, HardDrive, MoreHorizontal, PanelRightClose, PanelRightOpen, Pencil, Plus, RefreshCw, Server, Settings2, Smartphone, TerminalSquare, Trash2, X } from 'lucide-react'
import type { Agent, AlertAISettings, AlertAIStatus, ConnectionStatus, Host, HostMetrics, MobileStatus, Mode, Notice, Project, SavedState, SessionInfo, UpdateState, WorkspaceTab } from '../../shared/types'
import { TerminalPane } from './TerminalPane'
import { EditorPane } from './EditorPane'
import { BrowserPane } from './BrowserPane'
import { FileTree } from './FileTree'
import { decodeCompletionSound, isFreshNotice, playCompletionSound } from './completion-sound'
import { mergeNotice, shouldNotifyNotice, unreadNoticesForSession, unreadNoticesForTab, unreadSessionCountForProject } from './session-notices'
import { AlertAISettingsDialog } from './AlertAISettingsDialog'
import { hasWorkingAgent, sessionNameKey, sortSessionsByStart } from '../../shared/session-list'
import { mobilePairingURL } from '../../shared/mobile-pairing'

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
  const [state, setState] = useState<SavedState>(empty)
  const [loaded, setLoaded] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [sessions, setSessions] = useState<Record<string, SessionInfo[]>>({})
  const [hostMetrics, setHostMetrics] = useState<Record<string, HostMetrics>>({})
  const [hostMetricErrors, setHostMetricErrors] = useState<Record<string, boolean>>({})
  const [hookSettings, setHookSettings] = useState<Record<string, boolean>>({})
  const [clockNow, setClockNow] = useState(Date.now())
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({})
  const [visitedTerminalTabs, setVisitedTerminalTabs] = useState<string[]>([])
  const [agent, setAgent] = useState<Agent>('claude')
  const [mode, setMode] = useState<Mode>('normal')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [editingHost, setEditingHost] = useState<Host | undefined>()
  const [editingProject, setEditingProject] = useState<Project | undefined>()
  const [projectHostId, setProjectHostId] = useState('')
  const [error, setError] = useState('')
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [alertAIOpen, setAlertAIOpen] = useState(false)
  const [alertAISettings, setAlertAISettings] = useState<AlertAISettings | null>(null)
  const [alertAIStatus, setAlertAIStatus] = useState<AlertAIStatus>({ state: 'idle', detail: 'Sin análisis todavía.' })
  const noticesRef = useRef<Notice[]>([])
  const [soundName, setSoundName] = useState('')
  const [soundBusy, setSoundBusy] = useState(false)
  const [soundError, setSoundError] = useState('')
  const customSound = useRef<AudioBuffer | null>(null)
  const soundGeneration = useRef(0)
  const soundInput = useRef<HTMLInputElement>(null)
  const [filePanelOpen, setFilePanelOpen] = useState(true)
  const [passphraseHostId, setPassphraseHostId] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [passphraseVisible, setPassphraseVisible] = useState(false)
  const [passphraseError, setPassphraseError] = useState('')
  const [passphraseBusy, setPassphraseBusy] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileStatus, setMobileStatus] = useState<MobileStatus>({ running: false })
  const [mobileAddresses, setMobileAddresses] = useState<string[]>([])
  const [mobileAddress, setMobileAddress] = useState('')
  const [mobileBusy, setMobileBusy] = useState(false)
  const [mobileError, setMobileError] = useState('')
  const [mobileQR, setMobileQR] = useState('')

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

  const cacheTimer = (sessionsByProject[selectedProjectId] || [])
    .filter((session) => session.agent === 'claude' && !!session.cacheExpiresAt && Date.parse(session.cacheExpiresAt) > clockNow)
    .sort((a, b) => Date.parse(a.cacheExpiresAt!) - Date.parse(b.cacheExpiresAt!))[0]
  const cacheSeconds = cacheTimer ? Math.ceil((Date.parse(cacheTimer.cacheExpiresAt!) - clockNow) / 1000) : 0

  function sessionDisplayName(hostId: string, sessionId: string, agent: Agent): string {
    return state.sessionNames[sessionNameKey(hostId, sessionId)]?.trim() || labelFor(agent)
  }

  useEffect(() => { const timer = setInterval(() => setClockNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => { noticesRef.current = state.notices }, [state.notices])

  useEffect(() => {
    let live = true
    void window.crow.getAlertAISettings().then((value) => { if (live) setAlertAISettings(value) }).catch(() => undefined)
    void window.crow.getAlertAIStatus().then((value) => { if (live) setAlertAIStatus(value) }).catch(() => undefined)
    const off = window.crow.onAlertAIStatus(setAlertAIStatus)
    return () => { live = false; off() }
  }, [])

  useEffect(() => {
    if (activeTab?.kind !== 'terminal') return
    setVisitedTerminalTabs((current) => current.includes(activeTab.id) ? current : [...current, activeTab.id])
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

  useEffect(() => {
    if (!mobileOpen || !mobileStatus.running || !mobileStatus.url || !mobileStatus.pairingCode) { setMobileQR(''); return }
    let active = true
    void QRCode.toDataURL(mobilePairingURL(mobileStatus.url, mobileStatus.pairingCode), {
      width: 256, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' }
    }).then((url) => { if (active) setMobileQR(url) })
      .catch((reason) => { if (active) setMobileError(`No se pudo generar el QR: ${String(reason)}`) })
    return () => { active = false }
  }, [mobileOpen, mobileStatus.running, mobileStatus.url, mobileStatus.pairingCode])

  useEffect(() => {
    if (!mobileOpen || !mobileStatus.running || mobileStatus.paired) return
    const timer = setInterval(() => { void window.crow.mobileStatus().then(setMobileStatus).catch(() => undefined) }, 1500)
    return () => clearInterval(timer)
  }, [mobileOpen, mobileStatus.running, mobileStatus.paired])

  async function refreshHooks(hostId: string): Promise<void> {
    try { const next = await window.crow.hookSettings(hostId); setHookSettings((current) => ({ ...current, [hostId]: next.enabled })) }
    catch { /* Older remote runtimes may not provide this endpoint. */ }
  }

  async function refreshSessions(hostId: string): Promise<void> {
    try {
      const items = await window.crow.sessions(hostId)
      setSessions((current) => ({ ...current, [hostId]: items }))
    } catch { /* The status indicator shows the disconnect. */ }
  }

  useEffect(() => {
    let live = true
    void window.crow.getState().then(async (saved) => {
      if (!live) return
      setState(saved)
      setTabs(saved.tabs || [])
      setActiveTabs(saved.activeTabs || {})
      setSelectedProjectId(saved.projects.some((project) => project.id === saved.selectedProjectId) ? saved.selectedProjectId : saved.projects[0]?.id || '')
      const pairs = await Promise.all(saved.hosts.map(async (host) => [host.id, await window.crow.status(host.id)] as const))
      if (live) {
        setStatuses(Object.fromEntries(pairs))
        setLoaded(true)
        for (const [hostId, hostStatus] of pairs) if (hostStatus === 'connected') { void refreshSessions(hostId); void refreshHooks(hostId) }
        const authHost = pairs.find(([, status]) => status === 'auth-required')
        if (authHost) setPassphraseHostId(authHost[0])
      }
    }).catch((reason) => { if (live) setError(String(reason)) })
    const offStatus = window.crow.onStatus((hostId, next) => {
      setStatuses((current) => ({ ...current, [hostId]: next }))
      if (next === 'connected') { void refreshSessions(hostId); void refreshHooks(hostId) }
    })
    const offNotice = window.crow.onNotice((notice) => {
      const notify = shouldNotifyNotice(noticesRef.current, notice)
      noticesRef.current = mergeNotice(noticesRef.current, notice)
      setState((current) => ({ ...current, notices: mergeNotice(current.notices, notice) }))
      if (notify && isFreshNotice(notice.at)) void playCompletionSound(customSound.current).catch(() => setSoundError('No se pudo reproducir la alerta. Revisá el dispositivo de audio y usá Probar sonido.'))
      void refreshSessions(notice.hostId)
    })
    const offPassphrase = window.crow.onPassphraseRequired((hostId) => {
      setPassphraseHostId(hostId)
      setPassphraseError('')
    })
    const offUpdate = window.crow.onUpdateState(setUpdateState)
    void window.crow.getUpdateState().then((current) => { if (live) setUpdateState(current) }).catch(() => undefined)
    return () => { live = false; offStatus(); offNotice(); offPassphrase(); offUpdate() }
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

  function openTab(tab: WorkspaceTab): void {
    const existing = tabs.find((item) => item.projectId === tab.projectId && item.kind === tab.kind && (tab.kind === 'terminal' ? item.sessionId === tab.sessionId : tab.kind === 'editor' ? item.path === tab.path : true))
    const target = existing || tab
    if (!existing) setTabs((current) => [...current, tab])
    selectTab(target)
  }

  function acknowledgeTab(tab: WorkspaceTab): void {
    void markNotices(unreadNoticesForTab(state.notices, state.projects, tab).map((notice) => notice.id))
  }

  function selectTab(tab: WorkspaceTab): void {
    setSelectedProjectId(tab.projectId)
    setActiveTabs((current) => ({ ...current, [tab.projectId]: tab.id }))
    acknowledgeTab(tab)
  }

  function closeTab(id: string): void {
    const tab = tabs.find((item) => item.id === id)
    if (!tab) return
    const remaining = tabs.filter((item) => item.id !== id)
    setTabs(remaining)
    if (activeTabs[tab.projectId] === id) {
      setActiveTabs((current) => ({ ...current, [tab.projectId]: remaining.find((item) => item.projectId === tab.projectId)?.id || '' }))
    }
  }

  async function connect(hostId: string): Promise<void> {
    setError('')
    try { await window.crow.connect(hostId); await refreshSessions(hostId); await refreshHooks(hostId) }
    catch (reason) { setError(String(reason)) }
  }

  async function startSession(): Promise<void> {
    if (!selectedProject || !selectedHost) return
    if (mode === 'bypass' && !window.confirm('Bypass desactiva protecciones y aprobaciones del agente. ¿Querés iniciar esta sesión con acceso ampliado?')) return
    setError('')
    try {
      const session = await window.crow.startSession(selectedHost.id, selectedProject.id, agent, mode)
      setSessions((current) => ({ ...current, [selectedHost.id]: [...(current[selectedHost.id] || []), session] }))
      openTab({ id: crypto.randomUUID(), projectId: selectedProject.id, kind: 'terminal', sessionId: session.id })
    } catch (reason) { setError(String(reason)) }
  }

  async function deleteSession(hostId: string, session: SessionInfo): Promise<void> {
    if (!window.confirm(`¿Eliminar definitivamente la terminal ${sessionDisplayName(hostId, session.id, session.agent)} (${session.id.slice(0, 8)})? Se terminarán sus procesos remotos y se borrará el historial de terminal. Esta acción no se puede deshacer.`)) return
    setError('')
    try {
      await window.crow.saveWorkspace(tabs, activeTabs, selectedProjectId)
      const saved = await window.crow.deleteSession(hostId, session.id)
      setState(saved)
      setTabs(saved.tabs)
      setActiveTabs(saved.activeTabs)
      setSessions((current) => ({ ...current, [hostId]: (current[hostId] || []).filter((item) => item.id !== session.id) }))
    } catch (reason) { setError(String(reason)) }
  }

  async function renameSession(hostId: string, session: SessionInfo): Promise<void> {
    const key = sessionNameKey(hostId, session.id)
    const next = window.prompt('Nombre para esta terminal (dejalo vacío para usar el nombre del agente):', state.sessionNames[key] || '')
    if (next === null) return
    setError('')
    try { setState(await window.crow.renameSession(hostId, session.id, next)) }
    catch (reason) { setError(String(reason)) }
  }

  async function saveHost(input: Omit<Host, 'id'> & { id?: string }): Promise<void> {
    try {
      const saved = await window.crow.saveHost(input)
      setState(saved)
      const id = input.id || saved.hosts.at(-1)?.id
      if (id) void connect(id)
      setDialog(null)
      setEditingHost(undefined)
    } catch (reason) { setError(String(reason)) }
  }

  async function toggleHooks(hostId: string, enabled: boolean): Promise<void> {
    setError('')
    try {
      const next = await window.crow.setHookSettings(hostId, enabled)
      setHookSettings((current) => ({ ...current, [hostId]: next.enabled }))
      await refreshSessions(hostId)
    } catch (reason) { setError(String(reason)) }
  }

  async function saveProject(input: Omit<Project, 'id'> & { id?: string }): Promise<void> {
    try {
      const saved = await window.crow.saveProject(input)
      setState(saved)
      setSelectedProjectId(input.id || saved.projects.at(-1)?.id || '')
      setDialog(null)
      setEditingProject(undefined)
    } catch (reason) { setError(String(reason)) }
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

  async function openMobile(): Promise<void> {
    setMobileOpen(true)
    setMobileError('')
    try {
      const [addresses, current] = await Promise.all([window.crow.mobileAddresses(), window.crow.mobileStatus()])
      setMobileAddresses(addresses)
      setMobileAddress((value) => addresses.includes(value) ? value : addresses[0] || '')
      if (!current.running && addresses.length === 1) {
        setMobileBusy(true)
        try { setMobileStatus(await window.crow.mobileStart(addresses[0])) }
        catch (reason) { setMobileStatus(current); setMobileError(String(reason)) }
        finally { setMobileBusy(false) }
      } else setMobileStatus(current)
    } catch (reason) { setMobileError(String(reason)) }
  }

  async function toggleMobile(): Promise<void> {
    setMobileBusy(true)
    setMobileError('')
    try { setMobileStatus(mobileStatus.running ? await window.crow.mobileStop() : await window.crow.mobileStart(mobileAddress)) }
    catch (reason) { setMobileError(String(reason)) }
    finally { setMobileBusy(false) }
  }

  async function unlockHost(): Promise<void> {
    if (!passphraseHostId || !passphrase) return
    setPassphraseBusy(true)
    setPassphraseError('')
    try {
      await window.crow.submitPassphrase(passphraseHostId, passphrase)
      setPassphrase('')
      setPassphraseHostId('')
      setPassphraseVisible(false)
    } catch (reason) {
      setPassphraseError(String(reason))
      setPassphrase('')
    } finally { setPassphraseBusy(false) }
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

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Code2 size={18} /></span><span>CROW<span className="brand-soft"> HARNESS</span></span><button className="icon-button sidebar-action" title="Configuración" aria-label="Configuración" onClick={() => { setEditingHost(undefined); setDialog('host') }}><Settings2 size={16} /></button></div>
      <div className="sidebar-scroll">
        <div className="section-heading"><span>HOSTS</span><button className="icon-button" title="Agregar host" aria-label="Agregar host" onClick={() => { setEditingHost(undefined); setDialog('host') }}><Plus size={16} /></button></div>
        {state.hosts.length === 0 && <p className="sidebar-hint">Agregá un servidor para comenzar.</p>}
        {state.hosts.map((host) => <div key={host.id} className="host-group">
          <div className="host-row">
            <Server size={15} className="muted-icon" /><span className={`status-dot ${statuses[host.id] || 'disconnected'}`} title={statuses[host.id] || 'Desconectado'} />
            <span className="host-name">{host.name}</span>
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
                <span className={`session-state ${session.state} ${agentWorking ? 'agent-working' : ''}`} /><span className="session-name">{sessionDisplayName(host.id, session.id, session.agent)}</span><span className="session-tail">{session.id.slice(0, 5)}</span>
              </button>
              {unreadNoticesForSession(state.notices, host.id, session.id).length > 0 && <button className="session-notice" title="Abrir terminal y marcar alerta como leída" aria-label={`Abrir terminal ${sessionDisplayName(host.id, session.id, session.agent)} y marcar alerta como leída`} onClick={() => openTab({ id: crypto.randomUUID(), projectId: project.id, kind: 'terminal', sessionId: session.id })}><Bell size={14} fill="currentColor" aria-hidden="true" /></button>}
              <button className="session-rename" title="Renombrar terminal" aria-label={`Renombrar terminal ${sessionDisplayName(host.id, session.id, session.agent)}`} onClick={() => void renameSession(host.id, session)}><Pencil size={13} /></button>
              <button className="session-delete" title="Eliminar terminal y procesos remotos" aria-label={`Eliminar terminal ${sessionDisplayName(host.id, session.id, session.agent)}`} onClick={() => void deleteSession(host.id, session)}><Trash2 size={13} /></button>
            </div>
            })}
          </div>
          })}
          <button className="sidebar-add-project" onClick={() => { setEditingProject(undefined); setProjectHostId(host.id); setDialog('project') }}><Plus size={13} /> Agregar proyecto</button>
        </div>)}
      </div>
      <div className="sidebar-footer"><HardDrive size={14} /><span>Windows · Hosts Linux</span></div>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>{selectedHost?.name || 'Sin host'}</span><ChevronRight size={14} /><strong>{selectedProject?.name || 'Seleccioná un proyecto'}</strong><span className={`connection-pill ${status}`}>{status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Reconectando' : status === 'auth-required' ? 'Frase requerida' : 'Desconectado'}</span></div>
        <div className="host-metrics" aria-label="Recursos de los servidores">{state.hosts.map((host) => {
          if (statuses[host.id] === 'connected' && hostMetricErrors[host.id]) return <div key={host.id} className="host-metric" title={`El servicio crowd de ${host.name} está desactualizado. Actualizalo y reinicialo en Linux para ver métricas y eliminar terminales.`}><span className="host-metric-name">{host.name}</span><span className="metric-outdated">Actualizar crowd Linux</span></div>
          const sample = statuses[host.id] === 'connected' ? hostMetrics[host.id] : undefined
          return <div key={host.id} className="host-metric" title={`Servidor ${host.name}: CPU, memoria, disco raíz y terminales suspendidas. La RAM suspendida es consumo estimado, no memoria liberada.`}><span className="host-metric-name">{host.name}</span><span>CPU {sample?.cpuPercent == null ? '—' : `${Math.round(sample.cpuPercent)}%`}</span><span>RAM {sample ? percent(sample.memoryUsed, sample.memoryTotal) : '—'}</span><span>DISCO {sample ? percent(sample.diskUsed, sample.diskTotal) : '—'}</span><span className="sleeping-metric" role="status" aria-atomic="true">Suspendidas {sample?.sleepingSessions ?? '—'} · RAM ≈{sample ? memory(sample.sleepingMemory || 0) : '—'}</span></div>
        })}</div>
        <div className="top-actions">
          {cacheTimer && <span className="cache-timer" title={`Caché Claude estimada · sesión ${cacheTimer.id.slice(0, 8)}. No consulta al proveedor ni garantiza una caché activa.`}><Clock3 size={13} /> Caché ≈{Math.floor(cacheSeconds / 60)}:{String(cacheSeconds % 60).padStart(2, '0')}</span>}
          <button className="icon-button" title="Acceso móvil en red local" aria-label="Acceso móvil en red local" onClick={() => void openMobile()}><Smartphone size={16} /></button>
          <button className="icon-button" title="Buscar actualizaciones" aria-label="Buscar actualizaciones" disabled={['checking', 'available', 'downloading', 'downloaded'].includes(updateState.status)} onClick={() => void window.crow.checkForUpdates().catch(() => undefined)}><RefreshCw size={16} /></button>
          <button className="icon-button" title="Mostrar archivos" aria-label="Mostrar archivos" onClick={() => setFilePanelOpen((value) => !value)}>{filePanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button>
          <div className="notice-container"><button className="icon-button notice-button" title="Notificaciones" aria-label="Notificaciones" onClick={() => setNoticeOpen((value) => !value)}><Bell size={17} />{unread > 0 && <span className="notice-count">{unread}</span>}</button>
             {noticeOpen && <div className="notice-popover"><div className="popover-title">Actividad de agentes<button className="sound-test" onClick={() => void playCompletionSound(customSound.current).catch((reason) => setSoundError(`No se pudo reproducir el sonido: ${String(reason)}`))}>Probar sonido</button></div><div className="sound-settings"><span className="sound-name" title={soundName || 'Tono predeterminado'}>Sonido: {soundName || 'Tono predeterminado'}</span><div className="sound-actions"><input ref={soundInput} className="sound-file-input" type="file" accept=".mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void chooseAlertSound(file) }} /><button className="sound-test" disabled={soundBusy} onClick={() => soundInput.current?.click()}>Elegir archivo</button>{(soundName || soundError) && <button className="sound-test" disabled={soundBusy} onClick={() => void restoreDefaultSound()}>Restaurar original</button>}</div><small>MP3, WAV u OGG · hasta 5 MB y 30 s</small><small>La alerta suena cuando el agente necesita tu intervención; los avisos informativos quedan sin sonido.</small><div className="alert-ai-summary"><button className="sound-test" onClick={() => setAlertAIOpen(true)}>Configurar IA · Free LLM</button><small>{alertAISettings?.enabled ? 'Clasificación por IA activada' : 'IA desactivada · reglas locales'}</small>{alertAISettings?.configurationError && <small className="ai-error" role="alert">{alertAISettings.configurationError}</small>}{alertAISettings?.enabled && <small className={alertAIStatus.state === 'error' ? 'ai-error' : ''} role="status">{alertAIStatus.detail}</small>}</div>{soundError && <small className="sound-error" role="alert">{soundError}</small>}</div>{state.notices.length === 0 && <p className="empty-small">Sin notificaciones.</p>}{state.notices.slice(0, 15).map((notice) => <button key={notice.id} className={`notice-item ${notice.requiresAttention && !notice.read ? 'unread' : ''}`} onClick={() => { void markNotices([notice.id]); setNoticeOpen(false) }}><span>{notice.classification?.source === 'pending' ? 'Analizando respuesta…' : notice.classification?.decision === 'uncertain' ? 'Revisión preventiva' : notice.requiresAttention ? 'Necesita tu atención' : notice.kind === 'turn-complete' ? 'Respuesta informativa' : 'Proceso finalizado'}</span><small>{notice.classification?.detail}</small><small>{state.hosts.find((host) => host.id === notice.hostId)?.name || 'Host'} · {new Date(notice.at).toLocaleString()}</small></button>)}</div>}
          </div>
        </div>
      </header>

      {(updateState.status === 'available' || updateState.status === 'downloading' || updateState.status === 'downloaded' || updateState.status === 'error') && <div className={`update-banner ${updateState.status}`} role="status" aria-live="polite">
        <span className="update-message"><Download size={15} />{updateState.status === 'available' ? `Actualización ${updateState.version || ''} disponible; descargando…` : updateState.status === 'downloading' ? `Descargando actualización… ${updateState.percent ?? 0}%` : updateState.status === 'downloaded' ? `Actualización ${updateState.version || ''} lista para instalar.` : 'No se pudo buscar actualizaciones.'}</span>
        {updateState.status === 'downloading' && <progress max="100" value={updateState.percent ?? 0} aria-label="Progreso de descarga" />}
        {updateState.status === 'downloaded' && <button className="primary-button small-button" onClick={() => void window.crow.installUpdate().catch((reason) => setError(String(reason)))}>Reiniciar y actualizar</button>}
        {updateState.status === 'error' && <button className="secondary-button small-button" onClick={() => void window.crow.checkForUpdates().catch(() => undefined)}>Reintentar</button>}
      </div>}

      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Cerrar error" onClick={() => setError('')}><X size={15} /></button></div>}

      {selectedProject && selectedHost ? <>
        <div className="toolbar">
          <div className="path-label"><Folder size={15} /><span title={selectedProject.root}>{selectedProject.root}</span></div>
          <div className="toolbar-right">
            <select aria-label="Agente" value={agent} onChange={(event) => { const next = event.target.value as Agent; setAgent(next); if (next === 'shell') setMode('normal') }}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="agy">Antigravity</option><option value="shell">Shell</option></select>
            <select aria-label="Modo de permisos" value={mode} disabled={agent === 'shell'} onChange={(event) => setMode(event.target.value as Mode)}><option value="normal">Permisos normales</option><option value="bypass">Bypass permisos</option></select>
            <button className="primary-button" disabled={status !== 'connected'} onClick={() => void startSession()}><Plus size={15} /> Terminal</button>
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
                  <button className="tab-close" title="Cerrar vista (la sesión remota sigue activa)" aria-label="Cerrar vista" onClick={() => closeTab(tab.id)}><X size={13} /></button>
                </div>
              })}
            </div>
            <div className="pane-body">
              {!activeTab && <div className="blank-state"><div className="blank-icon"><TerminalSquare size={30} /></div><h2>Tu espacio está listo</h2><p>Abrí una terminal con un agente, explorá archivos o iniciá el navegador del servidor.</p><button className="secondary-button" disabled={status !== 'connected'} onClick={() => void startSession()}><CirclePlus size={16} /> Nueva terminal</button></div>}
              {tabs.filter((tab) => tab.kind === 'terminal' && tab.sessionId && visitedTerminalTabs.includes(tab.id)).map((tab) => {
                const project = state.projects.find((item) => item.id === tab.projectId)
                if (!project) return null
                const active = activeTab?.id === tab.id && selectedProjectId === tab.projectId
                return <div key={tab.id} className="terminal-tab-slot" hidden={!active} onPointerDownCapture={() => acknowledgeTab(tab)}><TerminalPane hostId={project.hostId} sessionId={tab.sessionId!} status={statuses[project.hostId] || 'disconnected'} active={active} /></div>
              })}
              {activeTab?.kind === 'editor' && activeTab.path && <EditorPane key={activeTab.id} hostId={selectedHost.id} root={selectedProject.root} path={activeTab.path} status={status} />}
              {activeTab?.kind === 'browser' && <BrowserPane key={activeTab.id} hostId={selectedHost.id} root={selectedProject.root} initialURL={activeTab.url || 'http://localhost:3000'} status={status} onURL={(url) => setTabs((current) => current.some((tab) => tab.id === activeTab.id && tab.url !== url) ? current.map((tab) => tab.id === activeTab.id ? { ...tab, url } : tab) : current)} />}
            </div>
          </main>
          {filePanelOpen && <aside className="files-pane"><FileTree key={selectedProject.id} hostId={selectedHost.id} root={selectedProject.root} projectName={selectedProject.name} status={status} onOpen={(path) => openTab({ id: crypto.randomUUID(), projectId: selectedProject.id, kind: 'editor', path })} /></aside>}
        </div>
      </> : <div className="welcome"><div className="welcome-symbol"><Code2 size={36} /></div><h1>Un espacio para tus agentes</h1><p>Conectá un host Linux y agregá una carpeta de proyecto para empezar.</p><button className="primary-button" onClick={() => { setEditingHost(undefined); setDialog('host') }}><Plus size={16} /> Agregar host</button></div>}
      <footer className="statusbar"><span><span className={`status-dot ${status}`} /> {selectedHost?.name || 'Sin conexión'}</span><span>{selectedProject?.root || 'Crow Harness v0.1'}</span></footer>
    </div>
    {dialog === 'host' && <HostDialog host={editingHost} hostConnected={!!editingHost && statuses[editingHost.id] === 'connected'} hooksEnabled={editingHost ? hookSettings[editingHost.id] : undefined} onToggleHooks={editingHost ? (enabled) => toggleHooks(editingHost.id, enabled) : undefined} onClose={() => setDialog(null)} onSave={saveHost} onDelete={editingHost ? async () => { setState(await window.crow.removeHost(editingHost.id)); setDialog(null); if (selectedHost?.id === editingHost.id) setSelectedProjectId('') } : undefined} />}
    {dialog === 'project' && <ProjectDialog project={editingProject} hosts={state.hosts} defaultHostId={projectHostId || selectedHost?.id || state.hosts[0]?.id || ''} onClose={() => setDialog(null)} onSave={saveProject} />}
    {alertAIOpen && <AlertAISettingsDialog onClose={() => setAlertAIOpen(false)} onSaved={setAlertAISettings} />}
    {mobileOpen && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMobileOpen(false) }}><div className="dialog-card mobile-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-title">
      <div className="dialog-heading"><h2 id="mobile-title">Acceso móvil · red local</h2><button className="icon-button" aria-label="Cerrar" onClick={() => setMobileOpen(false)}><X size={18} /></button></div>
      <p>Compartí las terminales existentes con tu celular por HTTPS. La app de Windows debe seguir abierta y ambos dispositivos deben estar en la misma red.</p>
      {!mobileStatus.running ? <><label>Dirección de este equipo<select value={mobileAddress} onChange={(event) => setMobileAddress(event.target.value)}>{mobileAddresses.map((address) => <option key={address} value={address}>{address}</option>)}</select></label>{mobileAddresses.length === 0 && <p>No se detectó una IPv4 privada. Conectá este equipo a una red local.</p>}</> : mobileStatus.paired ? <div className="mobile-qr-done" role="status">Celular conectado. Para revocar el acceso, detené el servidor móvil.</div> : <><div className="mobile-qr-panel"><strong>Escaneá el QR con la cámara del celular</strong>{mobileQR ? <img src={mobileQR} alt="QR de emparejamiento de un solo uso" width="256" height="256" /> : <span role="status">Generando QR…</span>}<small>El celular se emparejará automáticamente, sin escribir código.</small></div><details className="mobile-manual"><summary>No puedo escanear el QR</summary><div className="mobile-credentials"><div><strong>Dirección</strong><code>{mobileStatus.url}</code></div><div><strong>Código de un solo uso</strong><code>{mobileStatus.pairingCode}</code></div></div></details></>}
      {mobileStatus.running && <div className="mobile-fingerprint"><strong>Huella SHA-256 del certificado</strong><code>{mobileStatus.fingerprint}</code></div>}
      <p className="mobile-security-note">El certificado es autofirmado: el navegador avisará que no es de confianza. Compará su huella SHA-256 con la que aparece acá ANTES de aceptar la excepción. Usá solo una red privada confiable; no abras este puerto a Internet.</p>
      {mobileError && <div className="inline-error" role="alert">{mobileError}</div>}
      <div className="dialog-actions"><span /><button className="secondary-button" onClick={() => setMobileOpen(false)}>Cerrar</button><button className={mobileStatus.running ? 'danger-button' : 'primary-button'} disabled={mobileBusy || (!mobileStatus.running && !mobileAddress)} onClick={() => void toggleMobile()}>{mobileBusy ? 'Aplicando…' : mobileStatus.running ? 'Detener acceso' : 'Activar acceso'}</button></div>
    </div></div>}
    {passphraseHostId && <div className="dialog-backdrop"><form className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="passphrase-title" onSubmit={(event) => { event.preventDefault(); void unlockHost() }}>
      <div className="dialog-heading"><h2 id="passphrase-title">Desbloquear llave SSH</h2><button type="button" className="icon-button" aria-label="Cerrar" onClick={() => { setPassphraseHostId(''); setPassphrase(''); setPassphraseError('') }}><X size={18} /></button></div>
      <p>Ingresá la frase de la llave para conectar con {state.hosts.find((host) => host.id === passphraseHostId)?.name || 'el host'}. Se recordará en este equipo hasta reiniciar Windows.</p>
      <label>Frase de la llave SSH<div className="secret-field"><input autoFocus required type={passphraseVisible ? 'text' : 'password'} value={passphrase} aria-describedby={passphraseError ? 'passphrase-error' : undefined} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" /><button type="button" className="icon-button" aria-label={passphraseVisible ? 'Ocultar frase' : 'Mostrar frase'} onClick={() => setPassphraseVisible((value) => !value)}>{passphraseVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
      {passphraseError && <div id="passphrase-error" className="inline-error" role="alert">{passphraseError}</div>}
      <div className="dialog-actions"><span /><button type="button" className="secondary-button" onClick={() => { setPassphraseHostId(''); setPassphrase(''); setPassphraseError('') }}>Cancelar</button><button type="submit" className="primary-button" disabled={passphraseBusy || !passphrase}>{passphraseBusy ? 'Conectando…' : 'Conectar'}</button></div>
    </form></div>}
  </div>
}

function HostDialog({ host, hostConnected, hooksEnabled, onToggleHooks, onClose, onSave, onDelete }: { host?: Host; hostConnected: boolean; hooksEnabled?: boolean; onToggleHooks?: (enabled: boolean) => Promise<void>; onClose: () => void; onSave: (host: Omit<Host, 'id'> & { id?: string }) => Promise<void>; onDelete?: () => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState(host?.name || '')
  const [target, setTarget] = useState(host?.target || '')
  const [port, setPort] = useState(host?.port || 22)
  const [remotePort, setRemotePort] = useState(host?.remotePort || 47321)
  const [identity, setIdentity] = useState(host?.identity || '')
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void onSave({ id: host?.id, name, target, port, remotePort, identity: identity || undefined }) }}><div className="dialog-heading"><h2>{host ? 'Editar host' : 'Agregar host'}</h2><button type="button" className="icon-button" aria-label="Cerrar" onClick={onClose}><X size={18} /></button></div><p>Conexión SSH hacia el servicio Crow instalado en el servidor.</p><label>Nombre<input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="Servidor principal" /></label><label>Destino SSH<input required value={target} onChange={(event) => setTarget(event.target.value)} placeholder="usuario@servidor o alias" /></label><div className="dialog-columns"><label>Puerto SSH<input required type="number" min="1" max="65535" value={port} onChange={(event) => setPort(Number(event.target.value))} /></label><label>Puerto del servicio<input required type="number" min="1" max="65535" value={remotePort} onChange={(event) => setRemotePort(Number(event.target.value))} /></label></div><label>Archivo de clave SSH (opcional)<input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="C:\\Users\\...\\.ssh\\id_ed25519" /></label>{host && <label className="hook-toggle"><input type="checkbox" checked={hooksEnabled ?? false} disabled={!hostConnected || hooksEnabled === undefined} onChange={(event) => { void onToggleHooks?.(event.target.checked) }} /><span>Hooks de estado administrados por Crow<small>Trabajando, esperando y completado. Al desactivar se borra el hook de Crow en el servidor; aplica a nuevas sesiones.</small></span></label>}<div className="dialog-actions">{onDelete && <button type="button" className="danger-button" onClick={() => { if (window.confirm('¿Quitar este host y sus proyectos de la app? Las sesiones remotas no se cierran.')) void onDelete() }}>Quitar host</button>}<span /><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button">Guardar</button></div></form></div>
}

function ProjectDialog({ project, hosts, defaultHostId, onClose, onSave }: { project?: Project; hosts: Host[]; defaultHostId: string; onClose: () => void; onSave: (project: Omit<Project, 'id'> & { id?: string }) => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState(project?.name || '')
  const [hostId, setHostId] = useState(project?.hostId || defaultHostId)
  const [root, setRoot] = useState(project?.root || '')
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void onSave({ id: project?.id, name, hostId, root }) }}><div className="dialog-heading"><h2>Agregar proyecto</h2><button type="button" className="icon-button" aria-label="Cerrar" onClick={onClose}><X size={18} /></button></div><p>Elegí una carpeta existente en el servidor. No hace falta que sea un repositorio Git.</p><label>Nombre<input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="Mi aplicación" /></label><label>Host<select value={hostId} onChange={(event) => setHostId(event.target.value)}>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label><label>Carpeta absoluta en Linux<input required value={root} onChange={(event) => setRoot(event.target.value)} placeholder="/home/usuario/proyectos/mi-app" /></label><div className="dialog-actions"><span /><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button">Guardar proyecto</button></div></form></div>
}
