import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { CapacitorBarcodeScanner } from '@capacitor/barcode-scanner'
import { House, Folder, Bell, Settings, RefreshCw } from 'lucide-react'
import type { MobileBootstrap, MobileEnrollment, MobileNotice, MobileProject, MobileQuota, MobileSession } from '../../../src/shared/mobile-companion'
import { Gateway, api, type GatewayProfile } from './native'
import { parseEnrollment, parseEnrollmentBundle, decodeEnrollmentQR, staleQuota, mayWake, agentLabel, terminalTitle, sessionStateLabel, agentStateLabel, quotaStateLabel, hostStateLabel } from './protocol.mjs'
import { TerminalView } from './TerminalView'
import { ChatView } from './ChatView'
import './styles.css'

type Page = 'Inicio' | 'Proyectos' | 'Alertas' | 'Ajustes'
const pageIcons = [House, Folder, Bell, Settings]
function NavIcon({ index }: { index: number }) { const Icon = pageIcons[index]; return <Icon size={22} strokeWidth={1.8} aria-hidden="true" /> }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function MobileApp() {
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]), [profileId, setProfileId] = useState(''), [page, setPage] = useState<Page>('Inicio')
  const [bootstrap, setBootstrap] = useState<MobileBootstrap | null>(null), [hostId, setHostId] = useState(''), [sessions, setSessions] = useState<MobileSession[]>([]), [terminal, setTerminal] = useState<MobileSession | null>(null), [sessionMode, setSessionMode] = useState<'chat' | 'terminal'>('terminal')
  const [notices, setNotices] = useState<MobileNotice[]>([]), [quotas, setQuotas] = useState<MobileQuota[]>([]), [error, setError] = useState(''), [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'revoked'>('disconnected')
  const [enrolling, setEnrolling] = useState(false), [search, setSearch] = useState(''), [newProject, setNewProject] = useState<MobileProject | null>(null), [closing, setClosing] = useState<MobileSession | null>(null), [unlinking, setUnlinking] = useState<GatewayProfile[] | null>(null), [busy, setBusy] = useState(false)
  const generation = useRef(0), active = useRef(''), back = useRef(() => {}), profileListGeneration = useRef(0), foreground = useRef(true), retryRequested = useRef(false), retryAttempt = useRef(0)
  const sessionHeading = useRef<HTMLHeadingElement>(null), sessionOrigin = useRef<HTMLElement | null>(null), restoreSessionFocus = useRef(false)
  const profile = profiles.find(item => item.id === profileId)
  const terminalProfile = terminal ? profiles.find(item => item.mobileHostId === terminal.hostId && item.mobileHostId !== 'windows') || profile : profile
  const native = Capacitor.isNativePlatform()
  function openSession(session: MobileSession, origin: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null) {
    sessionOrigin.current = origin === document.body ? null : origin
    restoreSessionFocus.current = true
    setSessionMode(session.chatAvailable === true ? 'chat' : 'terminal')
    setTerminal(session)
  }
  useEffect(() => {
    if (terminal || !restoreSessionFocus.current) return
    restoreSessionFocus.current = false
    const origin = sessionOrigin.current
    sessionOrigin.current = null
    const frame = requestAnimationFrame(() => {
      const originIsVisible = !!origin && origin.isConnected && !origin.closest('[hidden]') && origin.getClientRects().length > 0
      if (originIsVisible) origin.focus()
      else sessionHeading.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [terminal])
  const changeProfile = useCallback((id: string) => { generation.current++; active.current = id; retryRequested.current = false; retryAttempt.current = 0; setProfileId(id); setBootstrap(null); setSessions([]); setQuotas([]); setNotices([]); setTerminal(null); setHostId(''); setError(''); setStatus('connecting') }, [])
  const selectedHost = bootstrap?.hosts.find(host => host.id === hostId)
  const hostProjects = bootstrap?.projects.filter(project => project.hostId === hostId) || []
  const fail = useCallback((text: string) => { setError(previous => { const warning = previous.includes('No se repite automáticamente') && !text.includes('No se repite automáticamente') ? ' No se repite automáticamente. Verificá la sesión antes de volver a intentar.' : ''; return `${text}${warning}` }); if (/revocado|vencido|forgotten|rechazó la autenticación del dispositivo|HTTP 401/i.test(text)) { retryRequested.current = false; setStatus('revoked'); setBootstrap(null); setSessions([]); setNotices([]); setQuotas([]); setTerminal(null) } else if (/sin conexión con crow en windows|sin conexión|desconectad|network/i.test(text)) { retryRequested.current = true; setStatus('disconnected') } }, [])
  const loadProfiles = useCallback(async () => {
    const version = ++profileListGeneration.current
    try { const result = await Gateway.listProfiles(); if (profileListGeneration.current !== version) return; setProfiles(result.profiles); const preferred = result.profiles.find(item => item.mobileHostId === 'windows') || result.profiles[0]; if (!active.current && preferred) changeProfile(preferred.id) }
    catch (reason) { if (profileListGeneration.current === version) fail(message(reason)) }
  }, [changeProfile, fail])
  useEffect(() => { if (native) void loadProfiles(); else setError('Vista de desarrollo sin conexión nativa. Vinculación y terminal requieren Android; no se usan datos ficticios.') }, [native, loadProfiles])
  const refresh = useCallback(async () => {
    const id = active.current, version = ++generation.current; if (!id) return; setStatus('connecting')
    try {
      const data = await api<MobileBootstrap>(id, '/api/v1/bootstrap'); if (active.current !== id || generation.current !== version) return
      if (data.version !== 1 || !data.device || !Array.isArray(data.projects) || !Array.isArray(data.hosts)) throw new Error('Protocolo incompatible con este companion.')
      setBootstrap(data); setProfiles(previous => previous.map(item => item.id === id ? { ...item, device: data.device } : item)); setHostId(previous => data.hosts.some(host => host.id === previous) ? previous : data.hosts[0]?.id || '')
      retryRequested.current = false; retryAttempt.current = 0; setStatus('connected'); setError(previous => previous.includes('No se repite automáticamente') ? previous : '')
      try {
        const authorizedNotices = await api<MobileNotice[]>(id, '/api/v1/notices'); if (active.current !== id || generation.current !== version) return; setNotices(authorizedNotices)
      } catch (reason) {
        if (active.current !== id || generation.current !== version) return
        const text = message(reason); if (/revocado|vencido|forgotten|rechazó la autenticación del dispositivo|HTTP 401/i.test(text)) { fail(text); return }
        setError(`No se pudieron actualizar los avisos: ${text}`)
      }
      if (data.device.capabilities.quotas) {
        try {
          const dataQuotas = await api<MobileQuota[]>(id, '/api/v1/quotas'); if (active.current === id && generation.current === version) setQuotas(dataQuotas)
        } catch (reason) {
          if (active.current !== id || generation.current !== version) return
          const text = message(reason); if (/revocado|vencido|forgotten|rechazó la autenticación del dispositivo|HTTP 401/i.test(text)) { fail(text); return }
          setError(`No se pudo actualizar el uso de cuentas: ${text}`)
        }
      }
    } catch (reason) { if (active.current === id && generation.current === version) {
      const text = message(reason)
      const directHost = profile?.mobileHostId === 'windows' ? profiles.find(candidate => candidate.mobileHostId && candidate.mobileHostId !== 'windows') : undefined
      if (directHost) { changeProfile(directHost.id); return }
      fail(text); if (!/revocado|vencido|forgotten|rechazó la autenticación del dispositivo|HTTP 401|sin conexión|desconectad|network/i.test(text)) setStatus('disconnected')
    } }
  }, [changeProfile, fail, profile?.mobileHostId, profiles])
  useEffect(() => { if (profileId) void refresh() }, [profileId, refresh])
  useEffect(() => {
    if (!profileId || status !== 'disconnected' || !retryRequested.current || !foreground.current) return
    const delay = Math.min(30000, 1000 * 2 ** Math.min(retryAttempt.current++, 5))
    const timer = setTimeout(() => { if (foreground.current) void refresh() }, delay)
    return () => clearTimeout(timer)
  }, [profileId, status, error, refresh])
  useEffect(() => {
    if (!profileId || !hostId || !bootstrap) return
    const available = selectedHost?.status === 'connected' && bootstrap.projects.some(project => project.hostId === hostId && (project.availability || 'available') === 'available')
    if (!available) { setSessions([]); return }
    let cancelled = false; const id = profileId, version = generation.current
    void api<MobileSession[]>(id, `/api/v1/sessions?hostId=${encodeURIComponent(hostId)}`).then(result => { if (!cancelled && active.current === id && generation.current === version) setSessions(result) }).catch(reason => { if (!cancelled && active.current === id && generation.current === version) fail(message(reason)) })
    return () => { cancelled = true }
  }, [profileId, hostId, bootstrap, selectedHost?.status, fail])
  back.current = () => {
    const dialog = document.querySelector('dialog[open]'); if (dialog) { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); return }
    if (terminal) setTerminal(null); else if (enrolling) setEnrolling(false); else if (page !== 'Inicio') setPage('Inicio'); else void App.minimizeApp()
  }
  useEffect(() => {
    if (!native) return
    const handles: { remove(): Promise<void> }[] = []; let disposed = false
    async function setup() {
      handles.push(await App.addListener('backButton', () => back.current()))
      handles.push(await App.addListener('appStateChange', state => { foreground.current = state.isActive; generation.current++; if (state.isActive) { void loadProfiles(); void refresh() } else setStatus('disconnected') }))
      if (disposed) for (const handle of handles) await handle.remove()
    }
    void setup(); return () => { disposed = true; for (const handle of handles) void handle.remove() }
  }, [native, loadProfiles, refresh])
  async function mutate(path: string, body: unknown, done: (result: MobileSession) => void) {
    if (!profile || busy) return; const id = profile.id, version = generation.current; setBusy(true)
    try { const result = await api<MobileSession>(id, path, 'POST', body); if (active.current === id && generation.current === version) { done(result); setError('') } }
    catch (reason) { if (active.current === id && generation.current === version) fail(`${message(reason)} No se repite automáticamente. Verificá la sesión antes de intentarlo otra vez.`) }
    finally { setBusy(false) }
  }
  async function openNotice(notice: MobileNotice, origin: HTMLElement) {
    const id = profileId, version = generation.current
    try { const allowed = await api<MobileSession[]>(id, `/api/v1/sessions?hostId=${encodeURIComponent(notice.hostId)}`); if (active.current !== id || version !== generation.current) return; const session = allowed.find(item => item.id === notice.sessionId); if (!session) throw new Error('Esta sesión ya no está disponible o autorizada.'); setHostId(notice.hostId); setSessions(allowed); openSession(session, origin) }
    catch (reason) { if (active.current === id && version === generation.current) fail(message(reason)) }
  }
  return <div className={`app ${terminal ? 'with-terminal' : ''}`}>
    <header><div><span className="brand">CROW · COMPANION</span><h1 ref={sessionHeading} tabIndex={-1}>{terminal ? sessionMode === 'chat' ? 'Chat' : 'Terminal' : enrolling ? 'Vincular equipos' : page}</h1></div>{!terminal && <button className="header-refresh" aria-label="Actualizar datos" title="Actualizar datos" disabled={!profile || busy || status === 'connecting'} onClick={() => void refresh()}><RefreshCw size={21} aria-hidden="true" /></button>}</header>
    {error && <div className="error" role="alert"><span>{error}</span><button aria-label="Descartar aviso" onClick={() => setError('')}>Cerrar</button></div>}
    {terminal && terminalProfile ? <>
      {terminal.chatAvailable === true ? <>
      <div className="session-mode-tabs" role="tablist" aria-label="Vista de la sesión" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        tabs[next]?.focus()
        tabs[next]?.click()
      }}>
        <button id="session-chat-tab" type="button" role="tab" tabIndex={sessionMode === 'chat' ? 0 : -1} aria-controls="session-chat-panel" aria-selected={sessionMode === 'chat'} onClick={() => setSessionMode('chat')}>Chat</button>
        <button id="session-terminal-tab" type="button" role="tab" tabIndex={sessionMode === 'terminal' ? 0 : -1} aria-controls="session-terminal-panel" aria-selected={sessionMode === 'terminal'} onClick={() => setSessionMode('terminal')}>Terminal</button>
      </div>
      <div id="session-chat-panel" role="tabpanel" aria-labelledby="session-chat-tab" className="session-mode-panel" hidden={sessionMode !== 'chat' || terminal.chatAvailable !== true}>
        {terminal.chatAvailable === true && <ChatView profile={terminalProfile} hostId={terminal.hostId || hostId} session={terminal} isActive={sessionMode === 'chat'} onBack={() => setTerminal(null)} onState={info => setTerminal(previous => previous && previous.id === info.id ? { ...previous, ...info } : previous)} />}
      </div>
      <div id="session-terminal-panel" role="tabpanel" aria-labelledby="session-terminal-tab" className="session-mode-panel" hidden={sessionMode === 'chat' && terminal.chatAvailable === true}>
        <TerminalView profile={terminalProfile} hostId={terminal.hostId || hostId} session={terminal} isActive={sessionMode === 'terminal'} onBack={() => setTerminal(null)} onError={fail} onState={info => setTerminal(previous => previous && previous.id === info.id ? { ...previous, ...info } : previous)} />
      </div>
      </> : <div className="session-mode-panel"><TerminalView profile={terminalProfile} hostId={terminal.hostId || hostId} session={terminal} onBack={() => setTerminal(null)} onError={fail} onState={info => setTerminal(previous => previous && previous.id === info.id ? { ...previous, ...info } : previous)} /></div>}
    </> : <main>
      {enrolling ? <Enrollment onCancel={() => setEnrolling(false)} onError={setError} onPaired={values => { profileListGeneration.current++; setProfiles(previous => [...previous, ...values]); changeProfile(values[0].id); setEnrolling(false); setPage('Inicio') }} /> : <>
        <section className={`connection connection-${status}`} aria-live="polite"><span className={`dot ${status}`} aria-hidden="true" /><div><strong>{profile ? profile.device.label : 'Sin equipos vinculados'}</strong><small>{status === 'connected' ? 'Vínculo activo' : status === 'connecting' ? 'Comprobando la conexión…' : status === 'revoked' ? 'Acceso rechazado o vencido · revisá el vínculo' : retryRequested.current ? 'Sin conexión · reintentando automáticamente' : 'Sin conexión · revisá el aviso y actualizá'}</small></div></section>
        {profiles.length > 1 && <section className="card"><label htmlFor="active-gateway">Equipo de trabajo</label><select id="active-gateway" value={profileId} onChange={event => changeProfile(event.target.value)}>{profiles.map(item => <option value={item.id} key={item.id}>{item.device.label} · {item.mobileHostId === 'windows' ? 'Crow Windows' : item.mobileHostId || 'equipo vinculado'}</option>)}</select></section>}
        {!profile && <section className="card"><h2>Tu workspace, desde Android</h2><p>Escaneá una vez el QR de Crow Windows. Después podés seguir las terminales de tus hosts Linux aunque apagues la PC. Android no guarda llaves SSH.</p><button className="primary" disabled={!native} onClick={() => setEnrolling(true)}>Vincular con QR</button></section>}
        {profile && bootstrap && <section className="host-picker" aria-label="Servidor actual"><label htmlFor="host">Servidor</label><select id="host" value={hostId} onChange={event => { setHostId(event.target.value); setSessions([]) }}>{bootstrap.hosts.map(host => <option value={host.id} key={host.id}>{host.name} · {hostStateLabel(host.status)}</option>)}</select></section>}
        {profile && page === 'Inicio' && <>
          <section className="card"><div className="section-heading"><div><span className="eyebrow">CONTINUAR TRABAJO</span><h2>Terminales</h2></div>{sessions.length > 0 && <span className="count">{sessions.length}</span>}</div>{sessions.length ? sessions.slice(0, 4).map(session => <SessionRow key={session.id} session={session} projectName={hostProjects.find(project => project.id === session.projectId)?.name} disabled={status !== 'connected'} onOpen={origin => openSession(session, origin)} />) : <p className="empty-state">{status !== 'connected' ? 'Esperando conexión para mostrar las terminales.' : selectedHost?.status !== 'connected' ? 'Este servidor no está disponible ahora.' : hostProjects.some(project => (project.availability || 'available') === 'available') ? 'Todavía no hay terminales en este servidor.' : 'No hay proyectos autorizados disponibles en este servidor.'}</p>}<button className="text-action" onClick={() => setPage('Proyectos')}>Ver todos los proyectos <span aria-hidden="true">→</span></button></section>
          <section className="card"><div className="section-heading"><div><span className="eyebrow">SIEMPRE A MANO</span><h2>Uso de cuentas</h2></div></div>{!bootstrap?.device.capabilities.quotas ? <p className="empty-state">No autorizado para este dispositivo. Habilitalo al vincular desde Windows.</p> : !quotas.length ? <p className="empty-state">No hay muestras disponibles. No se interpreta como 0 %.</p> : quotas.map((quota) => <div className="quota" key={quota.id}><strong>{quota.label}</strong><small>{agentLabel(quota.provider)} · {quotaStateLabel(quota.state)}{staleQuota(quota.sampledAt) ? ' · muestra desactualizada' : ''}</small>{quota.windows.map(window => <p key={window.label}>{window.label}: <strong>{window.usedPercent === null ? 'No disponible' : `${window.usedPercent} % usado`}</strong>{window.resetsAt ? ` · renueva ${new Date(window.resetsAt).toLocaleString()}` : ''}</p>)}</div>)}</section>
        </>}
        {profile && page === 'Proyectos' && <>
          <label htmlFor="search">Buscar proyecto</label><input id="search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Nombre del proyecto" />
          {bootstrap?.projects.filter(project => project.hostId === hostId && project.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(project => {
            const projectAvailable = selectedHost?.status === 'connected' && (project.availability || 'available') === 'available'
            const unavailableMessage = project.availability === 'authorization-required'
              ? 'Este proyecto no quedó autorizado para la identidad activa. Revisá Acceso individual en Crow Windows y generá otra invitación.'
              : 'Este proyecto está seleccionado, pero el host no está disponible ahora. La vinculación se conserva.'
            return <section className="card" key={project.id}><h2>{project.name}</h2>{!projectAvailable && <p className="project-unavailable" role="status">{unavailableMessage}</p>}{sessions.filter(session => session.projectId === project.id).map(session => <div key={session.id}><SessionRow session={session} disabled={status !== 'connected' || !projectAvailable} onOpen={origin => openSession(session, origin)} />{session.canOperate && !session.readOnly && <div className="row">{bootstrap.supportedFeatures?.sessionWake !== false && mayWake(session, bootstrap.device) && <button disabled={busy || status !== 'connected' || !projectAvailable} onClick={event => { const origin = event.currentTarget; void mutate('/api/v1/wake', { hostId, sessionId: session.id }, value => { setSessions(previous => previous.map(item => item.id === value.id ? value : item)); openSession(value, origin) }) }}>Despertar</button>}{bootstrap.device.capabilities.close && <button className="danger" disabled={busy || status !== 'connected' || !projectAvailable} onClick={() => setClosing(session)}>Cerrar proceso…</button>}</div>}</div>)}{projectAvailable && bootstrap.device.capabilities.create && bootstrap.supportedFeatures?.sessionCreate !== false && <button className="primary" disabled={busy || status !== 'connected'} onClick={() => setNewProject(project)}>Nueva sesión</button>}{projectAvailable && bootstrap.supportedFeatures?.sessionCreate === false && <small>Modo host: podés usar terminales existentes. Para crear una, abrí Crow en Windows.</small>}</section>
          })}
          {bootstrap && !bootstrap.projects.some(project => project.hostId === hostId) && <p>No hay proyectos autorizados en este host.</p>}
          {bootstrap && hostProjects.length > 0 && !hostProjects.some(project => project.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="empty-state">No encontramos proyectos con ese nombre en {selectedHost?.name || 'este servidor'}.</p>}
        </>}
        {profile && page === 'Alertas' && <section className="card"><h2>Actividad autorizada</h2><p>Se actualiza al volver a la app o tocar ↻. Sin notificaciones de fondo en esta versión.</p>{notices.length ? notices.map(notice => <button className="notice" disabled={status !== 'connected'} key={notice.id} onClick={event => void openNotice(notice, event.currentTarget)}><span>{notice.kind === 'chat-history-limit' ? 'Historial de Chat limitado' : notice.kind === 'turn-complete' ? 'Turno completado' : 'Proceso finalizado'}{notice.requiresAttention ? ' · requiere atención' : ''}{notice.kind === 'chat-history-limit' && <small>Las respuestas nuevas siguen en la terminal, pero no se guardan en Chat.</small>}<small>{new Date(notice.at).toLocaleString()}</small></span><span aria-hidden="true">→</span></button>) : <p>No hay avisos disponibles.</p>}</section>}
        {page === 'Ajustes' && <>
          <section className="card"><h2>Equipos vinculados</h2>{profiles.map(item => <div className="profile" key={item.id}><button aria-pressed={item.id === profileId} onClick={() => { if (item.id === profileId) void refresh(); else changeProfile(item.id) }}><strong>{item.device.label}</strong><small>{item.endpoint.kind === 'relay' ? 'Relay E2E · TLS fijado' : 'Conexión local'} · {item.endpoint.url}</small><small>{item.device.expiresAt ? `Vence ${new Date(item.device.expiresAt).toLocaleString()}` : 'Vínculo hasta desvinculación'}</small></button><button className="danger" onClick={() => setUnlinking([item])}>Desvincular</button></div>)}<button disabled={!native} className="primary" onClick={() => setEnrolling(true)}>Vincular otro equipo</button>{profiles.length > 1 && <button className="danger" onClick={() => setUnlinking([...profiles])}>Desvincular todos</button>}</section>
          <section className="card"><h2>Seguridad</h2><p>Cada equipo usa una clave no exportable de Android Keystore. Las credenciales temporales se renuevan con esa clave y nunca llegan a JavaScript. Al desvincular, Crow revoca el acceso remoto si está conectado y elimina la clave local incluso si está apagado.</p><p>Sin notificaciones FCM de fondo en esta versión.</p></section>
        </>}
      </>}
    </main>}
    {!terminal && !enrolling && <nav aria-label="Navegación principal">{(['Inicio', 'Proyectos', 'Alertas', 'Ajustes'] as Page[]).map((name, index) => <button aria-current={page === name ? 'page' : undefined} key={name} onClick={() => setPage(name)}><NavIcon index={index} />{name}</button>)}</nav>}
    {newProject && <CreateSession project={newProject} busy={busy} onCancel={() => setNewProject(null)} onCreate={(agent, origin) => void mutate('/api/v1/sessions', { hostId: newProject.hostId, projectId: newProject.id, agent }, session => { setSessions(previous => [...previous, session]); openSession(session, origin); setNewProject(null) })} />}
    {closing && <ConfirmClose session={closing} busy={busy} onCancel={() => setClosing(null)} onConfirm={() => void mutate('/api/v1/close', { hostId, sessionId: closing.id }, () => { setSessions(previous => previous.filter(session => session.id !== closing.id)); setClosing(null) })} />}
    {unlinking && <ConfirmUnlink label={unlinking.length === 1 ? unlinking[0].device.label : `todos los ${unlinking.length} equipos`} busy={busy} onCancel={() => setUnlinking(null)} onConfirm={() => { const targets = [...unlinking], removed: string[] = []; setBusy(true); generation.current++; profileListGeneration.current++; void (async () => { for (const item of targets) { await Gateway.deleteProfile({ profileId: item.id }); removed.push(item.id); setProfiles(previous => previous.filter(value => value.id !== item.id)) } setUnlinking(null) })().catch(reason => fail(message(reason))).finally(() => { if (removed.includes(active.current)) changeProfile(profiles.find(item => !removed.includes(item.id))?.id || ''); setBusy(false) }) }} />}
  </div>
}
function SessionRow({ session, projectName, disabled, onOpen }: { session: MobileSession; projectName?: string; disabled: boolean; onOpen(origin: HTMLButtonElement): void }) { return <button className="session" disabled={disabled} onClick={event => onOpen(event.currentTarget)}><span><strong>{terminalTitle(session)}</strong><small>{projectName ? `${projectName} · ` : ''}{agentLabel(session.agent)} · {sessionStateLabel(session.state)} · {agentStateLabel(session.agentState)}{!session.canOperate || session.readOnly ? ' · solo lectura' : ''}</small></span><span aria-hidden="true">→</span></button> }
function Enrollment({ onCancel, onError, onPaired }: { onCancel(): void; onError(message: string): void; onPaired(profiles: GatewayProfile[]): void }) {
  const [raw, setRaw] = useState(''), [invitations, setInvitations] = useState<Array<{ hostId: string; hostName: string; enrollment: MobileEnrollment }>>([]), [label, setLabel] = useState('Mi Android'), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  async function review(value: string) { try { const parsed = value.startsWith('crow3:') ? null : JSON.parse(value); const items = value.startsWith('crow3:') ? await decodeEnrollmentQR(value) as Array<{ hostId: string; hostName: string; enrollment: MobileEnrollment }> : parsed?.version === 3 ? parseEnrollmentBundle(value) as Array<{ hostId: string; hostName: string; enrollment: MobileEnrollment }> : [{ hostId: 'windows', hostName: 'Crow Windows', enrollment: parseEnrollment(value) as MobileEnrollment }]; if (!mounted.current) return; setInvitations(items); setRaw(''); setConfirmed(false) } catch (error) { if (mounted.current) onError(message(error)) } }
  async function scan() {
    setBusy(true)
    try { const result = await CapacitorBarcodeScanner.scanBarcode({ hint: 0, scanInstructions: 'Escaneá la invitación de Crow en Windows', scanButton: false, cameraDirection: 1, scanOrientation: 3 }); if (mounted.current && result.ScanResult) await review(result.ScanResult) }
    catch { onError('No se pudo escanear o no se autorizó la cámara. Podés pegar el JSON de invitación o importar su archivo.') }
    finally { setBusy(false) }
  }
  async function pair() {
    if (!invitations.length) return; setBusy(true)
    const paired: GatewayProfile[] = []
    try {
      for (const item of invitations) {
        const endpointIndex = Math.max(0, item.enrollment.endpoints.findIndex(endpoint => endpoint.kind === 'relay'))
        const result = await Gateway.pair({ enrollment: item.enrollment, endpointIndex, deviceName: `${label.trim()} · ${item.hostName}`.slice(0, 80), destinationConfirmed: confirmed, mobileHostId: item.hostId })
        paired.push(result.profile)
      }
      if (!mounted.current) { for (const item of paired) await Gateway.deleteProfile({ profileId: item.id }); return }
      setInvitations([]); onPaired(paired)
    } catch (error) {
      if (mounted.current) onError(`${message(error)} ${paired.length ? `${paired.length} equipo(s) sí quedaron vinculados; podés verlos en Ajustes.` : 'No se vinculó ningún equipo.'}`)
      if (paired.length) onPaired(paired)
      setInvitations([])
    } finally { if (mounted.current) setBusy(false) }
  }
  return <section className="card"><button onClick={onCancel} disabled={busy}>← Volver</button><h2>{invitations.length ? 'Confirmá el vínculo' : 'Vincular Crow'}</h2>
    {!invitations.length ? <><p>En Crow Windows, abrí Acceso móvil y generá un QR para todos tus hosts.</p><button className="primary" disabled={busy} onClick={() => void scan()}>Escanear QR con cámara</button><label htmlFor="invite">Invitación JSON</label><textarea id="invite" rows={5} value={raw} onChange={event => setRaw(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Pegá la invitación completa" /><button disabled={!raw || busy} onClick={() => void review(raw)}>Revisar invitación</button><label htmlFor="import">O importar archivo de invitación</label><input id="import" type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; if (file && file.size <= 32768) void file.text().then(value => review(value)); else onError('El archivo de invitación debe ser JSON de hasta 32 KiB.') }} /></> : <>
      <p>Se vincularán {invitations.length} equipos con este único QR. El relay solo transporta bytes cifrados; cada equipo valida tu identidad y permisos.</p>
      {invitations.map(item => <div className="profile" key={item.hostId}><strong>{item.hostName}</strong><code className="fingerprint">{item.enrollment.endpoints.find(endpoint => endpoint.kind === 'relay')?.certSHA256 || item.enrollment.endpoints[0]?.certSHA256 || 'HTTPS de confianza'}</code></div>)}
      <label className="check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{invitations.some(item => item.enrollment.endpoints.some(endpoint => endpoint.proxyAuthRequired)) ? 'El dominio coincide exactamente con Windows' : 'Reconozco los equipos y confirmo este QR generado en mi Crow'}</label>
      <label htmlFor="device-label">Nombre de este dispositivo</label><input id="device-label" maxLength={50} value={label} onChange={event => setLabel(event.target.value)} /><button className="primary" disabled={busy || !label.trim() || !confirmed} onClick={() => void pair()}>{busy ? 'Vinculando equipos…' : 'Vincular todos'}</button><button disabled={busy} onClick={() => setInvitations([])}>Usar otra invitación</button>
    </>}
  </section>
}
function CreateSession({ project, busy, onCancel, onCreate }: { project: MobileProject; busy: boolean; onCancel(): void; onCreate(agent: 'claude' | 'codex', origin: HTMLButtonElement): void }) {
  const dialog = useRef<HTMLDialogElement>(null); const [agent, setAgent] = useState<'claude' | 'codex'>('claude'), [review, setReview] = useState(false)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return <dialog ref={dialog} aria-labelledby="create-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}><h2 id="create-title">{review ? 'Revisá la sesión' : 'Nueva sesión'}</h2><p>Proyecto: <strong>{project.name}</strong></p>{review ? <p>{agentLabel(agent)} · modo normal · sin permisos peligrosos. El proceso se creará desde Windows en el host configurado.</p> : <><label htmlFor="agent">Agente</label><select autoFocus id="agent" value={agent} onChange={event => setAgent(event.target.value as 'claude' | 'codex')}><option value="claude">Claude</option><option value="codex">Codex</option></select></>}<div className="row"><button disabled={busy} onClick={review ? () => setReview(false) : onCancel}>{review ? 'Atrás' : 'Cancelar'}</button><button disabled={busy} className="primary" onClick={event => review ? onCreate(agent, event.currentTarget) : setReview(true)}>{busy ? 'Creando…' : review ? 'Crear sesión' : 'Revisar'}</button></div></dialog>
}
function ConfirmClose({ session, busy, onCancel, onConfirm }: { session: MobileSession; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null); useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return <dialog ref={dialog} aria-labelledby="close-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}><h2 id="close-title">¿Cerrar el proceso?</h2><p>Terminará {agentLabel(session.agent)} en este proyecto. Para salir de la terminal sin detenerlo, usá Volver.</p><div className="row"><button autoFocus disabled={busy} onClick={onCancel}>Cancelar</button><button className="danger" disabled={busy} onClick={onConfirm}>Cerrar proceso</button></div></dialog>
}
function ConfirmUnlink({ label, busy, onCancel, onConfirm }: { label: string; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null); useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return <dialog ref={dialog} aria-labelledby="unlink-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}><h2 id="unlink-title">Desvincular equipo</h2><p>Se eliminará la clave local de «{label}». Para volver a conectarlo necesitarás un QR nuevo.</p><div className="row"><button autoFocus disabled={busy} onClick={onCancel}>Cancelar</button><button className="danger" disabled={busy} onClick={onConfirm}>{busy ? 'Desvinculando…' : 'Desvincular'}</button></div></dialog>
}
function viewport() { document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`) }
window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport()
createRoot(document.getElementById('root')!).render(<MobileApp />)
