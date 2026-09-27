import { useEffect, useMemo, useState } from 'react'
import { Bell, ChevronDown, ChevronRight, CirclePlus, Code2, Download, Eye, EyeOff, FileCode2, Folder, FolderOpen, Globe2, HardDrive, MoreHorizontal, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Server, Settings2, TerminalSquare, Trash2, X } from 'lucide-react'
import type { Agent, ConnectionStatus, Host, HostMetrics, Mode, Project, SavedState, SessionInfo, UpdateState, WorkspaceTab } from '../../shared/types'
import { TerminalPane } from './TerminalPane'
import { EditorPane } from './EditorPane'
import { BrowserPane } from './BrowserPane'
import { FileTree } from './FileTree'

type Dialog = 'host' | 'project' | null
const labelFor = (agent: Agent): string => ({ shell: 'Shell', claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' })[agent]
const empty: SavedState = { hosts: [], projects: [], notices: [], eventCursors: {}, tabs: [], activeTabs: {}, selectedProjectId: '' }
const percent = (used: number, total: number): string => total > 0 ? `${Math.round(used / total * 100)}%` : '—'
const memory = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`

export function App(): React.JSX.Element {
  const [state, setState] = useState<SavedState>(empty)
  const [loaded, setLoaded] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [sessions, setSessions] = useState<Record<string, SessionInfo[]>>({})
  const [hostMetrics, setHostMetrics] = useState<Record<string, HostMetrics>>({})
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({})
  const [agent, setAgent] = useState<Agent>('claude')
  const [mode, setMode] = useState<Mode>('normal')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [editingHost, setEditingHost] = useState<Host | undefined>()
  const [editingProject, setEditingProject] = useState<Project | undefined>()
  const [projectHostId, setProjectHostId] = useState('')
  const [error, setError] = useState('')
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [filePanelOpen, setFilePanelOpen] = useState(true)
  const [fileRefresh, setFileRefresh] = useState(0)
  const [passphraseHostId, setPassphraseHostId] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [passphraseVisible, setPassphraseVisible] = useState(false)
  const [passphraseError, setPassphraseError] = useState('')
  const [passphraseBusy, setPassphraseBusy] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })

  const selectedProject = state.projects.find((project) => project.id === selectedProjectId)
  const selectedHost = selectedProject && state.hosts.find((host) => host.id === selectedProject.hostId)
  const status = selectedHost ? statuses[selectedHost.id] || 'disconnected' : 'disconnected'
  const projectTabs = tabs.filter((tab) => tab.projectId === selectedProjectId)
  const activeTab = projectTabs.find((tab) => tab.id === activeTabs[selectedProjectId]) || projectTabs[0]
  const unread = state.notices.filter((notice) => !notice.read).length

  const sessionsByProject = useMemo(() => {
    const map: Record<string, SessionInfo[]> = {}
    for (const project of state.projects) map[project.id] = (sessions[project.hostId] || []).filter((session) => session.root === project.root)
    return map
  }, [state.projects, sessions])

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
        const authHost = pairs.find(([, status]) => status === 'auth-required')
        if (authHost) setPassphraseHostId(authHost[0])
      }
    }).catch((reason) => { if (live) setError(String(reason)) })
    const offStatus = window.crow.onStatus((hostId, next) => {
      setStatuses((current) => ({ ...current, [hostId]: next }))
      if (next === 'connected') void refreshSessions(hostId)
    })
    const offNotice = window.crow.onNotice((notice) => {
      setState((current) => ({ ...current, notices: [notice, ...current.notices].slice(0, 100) }))
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
    if (!selectedHost || status !== 'connected') return
    void refreshSessions(selectedHost.id)
    const timer = setInterval(() => void refreshSessions(selectedHost.id), 5000)
    return () => clearInterval(timer)
  }, [selectedHost?.id, status])

  useEffect(() => {
    const connected = state.hosts.filter((host) => statuses[host.id] === 'connected')
    if (connected.length === 0) return
    let live = true
    const refresh = async (): Promise<void> => {
      const values = await Promise.all(connected.map(async (host) => {
        try { return [host.id, await window.crow.hostMetrics(host.id)] as const }
        catch { return null }
      }))
      if (live) setHostMetrics((current) => ({ ...current, ...Object.fromEntries(values.filter((value) => value !== null)) }))
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10_000)
    return () => { live = false; clearInterval(timer) }
  }, [state.hosts, statuses])

  function openTab(tab: WorkspaceTab): void {
    const existing = tabs.find((item) => item.projectId === tab.projectId && item.kind === tab.kind && (tab.kind === 'terminal' ? item.sessionId === tab.sessionId : tab.kind === 'editor' ? item.path === tab.path : true))
    const target = existing || tab
    if (!existing) setTabs((current) => [...current, tab])
    setActiveTabs((current) => ({ ...current, [tab.projectId]: target.id }))
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
    try { await window.crow.connect(hostId); await refreshSessions(hostId) }
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
    if (!window.confirm(`¿Eliminar definitivamente la terminal ${labelFor(session.agent)} ${session.id.slice(0, 8)}? Se terminarán sus procesos remotos y se borrará el historial de terminal. Esta acción no se puede deshacer.`)) return
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

  async function saveProject(input: Omit<Project, 'id'> & { id?: string }): Promise<void> {
    try {
      const saved = await window.crow.saveProject(input)
      setState(saved)
      setSelectedProjectId(input.id || saved.projects.at(-1)?.id || '')
      setDialog(null)
      setEditingProject(undefined)
    } catch (reason) { setError(String(reason)) }
  }

  async function markNotice(id: string): Promise<void> {
    setState(await window.crow.markNoticeRead(id))
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
          {state.projects.filter((project) => project.hostId === host.id).map((project) => <div key={project.id}>
            <button className={`project-row ${selectedProjectId === project.id ? 'selected' : ''}`} onClick={() => setSelectedProjectId(project.id)}>
              {selectedProjectId === project.id ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span>{project.name}</span><ChevronRight size={13} className="project-chevron" />
            </button>
            {selectedProjectId === project.id && (sessionsByProject[project.id] || []).map((session) => <div key={session.id} className="session-entry">
              <button className="session-row" title={session.state === 'sleeping' ? 'Abrir terminal suspendida para reanudarla' : 'Abrir vista de terminal'} onClick={() => openTab({ id: crypto.randomUUID(), projectId: project.id, kind: 'terminal', sessionId: session.id })}>
                <span className={`session-state ${session.state}`} /><span>{labelFor(session.agent)}</span><span className="session-tail">{session.id.slice(0, 5)}</span>
              </button>
              <button className="session-delete" title="Eliminar terminal y procesos remotos" aria-label={`Eliminar terminal ${labelFor(session.agent)} ${session.id.slice(0, 5)}`} onClick={() => void deleteSession(host.id, session)}><Trash2 size={13} /></button>
            </div>)}
          </div>)}
          <button className="sidebar-add-project" onClick={() => { setEditingProject(undefined); setProjectHostId(host.id); setDialog('project') }}><Plus size={13} /> Agregar proyecto</button>
        </div>)}
      </div>
      <div className="sidebar-footer"><HardDrive size={14} /><span>Windows · Hosts Linux</span></div>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>{selectedHost?.name || 'Sin host'}</span><ChevronRight size={14} /><strong>{selectedProject?.name || 'Seleccioná un proyecto'}</strong><span className={`connection-pill ${status}`}>{status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Reconectando' : status === 'auth-required' ? 'Frase requerida' : 'Desconectado'}</span></div>
        <div className="host-metrics" aria-label="Recursos de los servidores">{state.hosts.map((host) => {
          const sample = statuses[host.id] === 'connected' ? hostMetrics[host.id] : undefined
          return <div key={host.id} className="host-metric" title={`Servidor ${host.name}: CPU, memoria, disco raíz y terminales suspendidas. La RAM suspendida es consumo estimado, no memoria liberada.`}><span className="host-metric-name">{host.name}</span><span>CPU {sample?.cpuPercent == null ? '—' : `${Math.round(sample.cpuPercent)}%`}</span><span>RAM {sample ? percent(sample.memoryUsed, sample.memoryTotal) : '—'}</span><span>DISCO {sample ? percent(sample.diskUsed, sample.diskTotal) : '—'}</span><span className="sleeping-metric" role="status" aria-atomic="true">Suspendidas {sample?.sleepingSessions ?? '—'} · RAM ≈{sample ? memory(sample.sleepingMemory || 0) : '—'}</span></div>
        })}</div>
        <div className="top-actions">
          <button className="icon-button" title="Buscar actualizaciones" aria-label="Buscar actualizaciones" disabled={['checking', 'available', 'downloading', 'downloaded'].includes(updateState.status)} onClick={() => void window.crow.checkForUpdates().catch(() => undefined)}><RefreshCw size={16} /></button>
          <button className="icon-button" title="Mostrar archivos" aria-label="Mostrar archivos" onClick={() => setFilePanelOpen((value) => !value)}>{filePanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button>
          <div className="notice-container"><button className="icon-button notice-button" title="Notificaciones" aria-label="Notificaciones" onClick={() => setNoticeOpen((value) => !value)}><Bell size={17} />{unread > 0 && <span className="notice-count">{unread}</span>}</button>
            {noticeOpen && <div className="notice-popover"><div className="popover-title">Actividad de agentes</div>{state.notices.length === 0 && <p className="empty-small">Sin notificaciones.</p>}{state.notices.slice(0, 15).map((notice) => <button key={notice.id} className={`notice-item ${notice.read ? '' : 'unread'}`} onClick={() => { void markNotice(notice.id); setNoticeOpen(false) }}><span>{notice.kind === 'turn-complete' ? 'Trabajo terminado' : 'Proceso finalizado'}</span><small>{state.hosts.find((host) => host.id === notice.hostId)?.name || 'Host'} · {new Date(notice.at).toLocaleString()}</small></button>)}</div>}
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
              {projectTabs.map((tab) => <div key={tab.id} className={`tab ${activeTab?.id === tab.id ? 'active' : ''}`} role="tab" aria-selected={activeTab?.id === tab.id}>
                <button className="tab-select" onClick={() => setActiveTabs((current) => ({ ...current, [selectedProject.id]: tab.id }))}>{tab.kind === 'terminal' ? <TerminalSquare size={14} /> : tab.kind === 'browser' ? <Globe2 size={14} /> : <FileCode2 size={14} />}<span>{tab.kind === 'terminal' ? labelFor(sessionsByProject[selectedProject.id]?.find((session) => session.id === tab.sessionId)?.agent || 'shell') : tab.kind === 'browser' ? 'Navegador' : tab.path?.split('/').at(-1)}</span></button>
                <button className="tab-close" title="Cerrar vista (la sesión remota sigue activa)" aria-label="Cerrar vista" onClick={() => closeTab(tab.id)}><X size={13} /></button>
              </div>)}
            </div>
            <div className="pane-body">
              {!activeTab && <div className="blank-state"><div className="blank-icon"><TerminalSquare size={30} /></div><h2>Tu espacio está listo</h2><p>Abrí una terminal con un agente, explorá archivos o iniciá el navegador del servidor.</p><button className="secondary-button" disabled={status !== 'connected'} onClick={() => void startSession()}><CirclePlus size={16} /> Nueva terminal</button></div>}
              {activeTab?.kind === 'terminal' && activeTab.sessionId && <TerminalPane key={activeTab.id} hostId={selectedHost.id} sessionId={activeTab.sessionId} status={status} />}
              {activeTab?.kind === 'editor' && activeTab.path && <EditorPane key={activeTab.id} hostId={selectedHost.id} root={selectedProject.root} path={activeTab.path} status={status} />}
              {activeTab?.kind === 'browser' && <BrowserPane key={activeTab.id} hostId={selectedHost.id} root={selectedProject.root} initialURL={activeTab.url || 'http://localhost:3000'} status={status} onURL={(url) => setTabs((current) => current.some((tab) => tab.id === activeTab.id && tab.url !== url) ? current.map((tab) => tab.id === activeTab.id ? { ...tab, url } : tab) : current)} />}
            </div>
          </main>
          {filePanelOpen && <aside className="files-pane"><div className="files-header"><span>EXPLORADOR</span><button className="icon-button" aria-label="Actualizar archivos" title="Actualizar archivos" onClick={() => setFileRefresh((value) => value + 1)}><RefreshCw size={14} /></button></div><div className="files-project"><ChevronDown size={14} /><FolderOpen size={15} /> {selectedProject.name}</div><FileTree key={`${selectedProject.id}:${fileRefresh}`} hostId={selectedHost.id} root={selectedProject.root} status={status} refreshKey={fileRefresh} onOpen={(path) => openTab({ id: crypto.randomUUID(), projectId: selectedProject.id, kind: 'editor', path })} /></aside>}
        </div>
      </> : <div className="welcome"><div className="welcome-symbol"><Code2 size={36} /></div><h1>Un espacio para tus agentes</h1><p>Conectá un host Linux y agregá una carpeta de proyecto para empezar.</p><button className="primary-button" onClick={() => { setEditingHost(undefined); setDialog('host') }}><Plus size={16} /> Agregar host</button></div>}
      <footer className="statusbar"><span><span className={`status-dot ${status}`} /> {selectedHost?.name || 'Sin conexión'}</span><span>{selectedProject?.root || 'Crow Harness v0.1'}</span></footer>
    </div>
    {dialog === 'host' && <HostDialog host={editingHost} onClose={() => setDialog(null)} onSave={saveHost} onDelete={editingHost ? async () => { setState(await window.crow.removeHost(editingHost.id)); setDialog(null); if (selectedHost?.id === editingHost.id) setSelectedProjectId('') } : undefined} />}
    {dialog === 'project' && <ProjectDialog project={editingProject} hosts={state.hosts} defaultHostId={projectHostId || selectedHost?.id || state.hosts[0]?.id || ''} onClose={() => setDialog(null)} onSave={saveProject} />}
    {passphraseHostId && <div className="dialog-backdrop"><form className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="passphrase-title" onSubmit={(event) => { event.preventDefault(); void unlockHost() }}>
      <div className="dialog-heading"><h2 id="passphrase-title">Desbloquear llave SSH</h2><button type="button" className="icon-button" aria-label="Cerrar" onClick={() => { setPassphraseHostId(''); setPassphrase(''); setPassphraseError('') }}><X size={18} /></button></div>
      <p>Ingresá la frase de la llave para conectar con {state.hosts.find((host) => host.id === passphraseHostId)?.name || 'el host'}. Se recordará en este equipo hasta reiniciar Windows.</p>
      <label>Frase de la llave SSH<div className="secret-field"><input autoFocus required type={passphraseVisible ? 'text' : 'password'} value={passphrase} aria-describedby={passphraseError ? 'passphrase-error' : undefined} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" /><button type="button" className="icon-button" aria-label={passphraseVisible ? 'Ocultar frase' : 'Mostrar frase'} onClick={() => setPassphraseVisible((value) => !value)}>{passphraseVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
      {passphraseError && <div id="passphrase-error" className="inline-error" role="alert">{passphraseError}</div>}
      <div className="dialog-actions"><span /><button type="button" className="secondary-button" onClick={() => { setPassphraseHostId(''); setPassphrase(''); setPassphraseError('') }}>Cancelar</button><button type="submit" className="primary-button" disabled={passphraseBusy || !passphrase}>{passphraseBusy ? 'Conectando…' : 'Conectar'}</button></div>
    </form></div>}
  </div>
}

function HostDialog({ host, onClose, onSave, onDelete }: { host?: Host; onClose: () => void; onSave: (host: Omit<Host, 'id'> & { id?: string }) => Promise<void>; onDelete?: () => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState(host?.name || '')
  const [target, setTarget] = useState(host?.target || '')
  const [port, setPort] = useState(host?.port || 22)
  const [remotePort, setRemotePort] = useState(host?.remotePort || 47321)
  const [identity, setIdentity] = useState(host?.identity || '')
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void onSave({ id: host?.id, name, target, port, remotePort, identity: identity || undefined }) }}><div className="dialog-heading"><h2>{host ? 'Editar host' : 'Agregar host'}</h2><button type="button" className="icon-button" aria-label="Cerrar" onClick={onClose}><X size={18} /></button></div><p>Conexión SSH hacia el servicio Crow instalado en el servidor.</p><label>Nombre<input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="Servidor principal" /></label><label>Destino SSH<input required value={target} onChange={(event) => setTarget(event.target.value)} placeholder="usuario@servidor o alias" /></label><div className="dialog-columns"><label>Puerto SSH<input required type="number" min="1" max="65535" value={port} onChange={(event) => setPort(Number(event.target.value))} /></label><label>Puerto del servicio<input required type="number" min="1" max="65535" value={remotePort} onChange={(event) => setRemotePort(Number(event.target.value))} /></label></div><label>Archivo de clave SSH (opcional)<input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="C:\\Users\\...\\.ssh\\id_ed25519" /></label><div className="dialog-actions">{onDelete && <button type="button" className="danger-button" onClick={() => { if (window.confirm('¿Quitar este host y sus proyectos de la app? Las sesiones remotas no se cierran.')) void onDelete() }}>Quitar host</button>}<span /><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button">Guardar</button></div></form></div>
}

function ProjectDialog({ project, hosts, defaultHostId, onClose, onSave }: { project?: Project; hosts: Host[]; defaultHostId: string; onClose: () => void; onSave: (project: Omit<Project, 'id'> & { id?: string }) => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState(project?.name || '')
  const [hostId, setHostId] = useState(project?.hostId || defaultHostId)
  const [root, setRoot] = useState(project?.root || '')
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void onSave({ id: project?.id, name, hostId, root }) }}><div className="dialog-heading"><h2>Agregar proyecto</h2><button type="button" className="icon-button" aria-label="Cerrar" onClick={onClose}><X size={18} /></button></div><p>Elegí una carpeta existente en el servidor. No hace falta que sea un repositorio Git.</p><label>Nombre<input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="Mi aplicación" /></label><label>Host<select value={hostId} onChange={(event) => setHostId(event.target.value)}>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label><label>Carpeta absoluta en Linux<input required value={root} onChange={(event) => setRoot(event.target.value)} placeholder="/home/usuario/proyectos/mi-app" /></label><div className="dialog-actions"><span /><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button">Guardar proyecto</button></div></form></div>
}
