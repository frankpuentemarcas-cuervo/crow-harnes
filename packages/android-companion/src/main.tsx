import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { CapacitorBarcodeScanner } from '@capacitor/barcode-scanner'
import { House, Folder, Bell, Settings, RefreshCw } from 'lucide-react'
import type { MobileBootstrap, MobileEnrollment, MobileNotice, MobileProject, MobileQuota, MobileSession } from '../../../src/shared/mobile-companion'
import { Gateway, api, type GatewayProfile } from './native'
import { parseEnrollment, staleQuota, mayWake, agentLabel, sessionStateLabel, agentStateLabel, quotaStateLabel, hostStateLabel } from './protocol.mjs'
import { TerminalView } from './TerminalView'
import './styles.css'

type Page = 'Inicio' | 'Proyectos' | 'Alertas' | 'Ajustes'
const pageIcons = [House, Folder, Bell, Settings]
function NavIcon({ index }: { index: number }) { const Icon = pageIcons[index]; return <Icon size={22} strokeWidth={1.8} aria-hidden="true" /> }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function MobileApp() {
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]), [profileId, setProfileId] = useState(''), [page, setPage] = useState<Page>('Inicio')
  const [bootstrap, setBootstrap] = useState<MobileBootstrap | null>(null), [hostId, setHostId] = useState(''), [sessions, setSessions] = useState<MobileSession[]>([]), [terminal, setTerminal] = useState<MobileSession | null>(null)
  const [notices, setNotices] = useState<MobileNotice[]>([]), [quotas, setQuotas] = useState<MobileQuota[]>([]), [error, setError] = useState(''), [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'revoked'>('disconnected')
  const [enrolling, setEnrolling] = useState(false), [search, setSearch] = useState(''), [newProject, setNewProject] = useState<MobileProject | null>(null), [closing, setClosing] = useState<MobileSession | null>(null), [busy, setBusy] = useState(false)
  const generation = useRef(0), active = useRef(''), back = useRef(() => {}), profileListGeneration = useRef(0)
  const profile = profiles.find(item => item.id === profileId)
  const native = Capacitor.isNativePlatform()
  const changeProfile = useCallback((id: string) => { generation.current++; active.current = id; setProfileId(id); setBootstrap(null); setSessions([]); setQuotas([]); setNotices([]); setTerminal(null); setHostId(''); setError(''); setStatus('connecting') }, [])
  const fail = useCallback((text: string) => { setError(text); if (/revocado|vencido|forgotten/i.test(text)) { setStatus('revoked'); setBootstrap(null); setSessions([]); setNotices([]); setQuotas([]); setTerminal(null) } else if (/sin conexión|desconectad|TLS:|network/i.test(text)) setStatus('disconnected') }, [])
  const loadProfiles = useCallback(async () => {
    const version = ++profileListGeneration.current
    try { const result = await Gateway.listProfiles(); if (profileListGeneration.current !== version) return; setProfiles(result.profiles); if (!active.current && result.profiles[0]) changeProfile(result.profiles[0].id) }
    catch (reason) { if (profileListGeneration.current === version) fail(message(reason)) }
  }, [changeProfile, fail])
  useEffect(() => { if (native) void loadProfiles(); else setError('Vista de desarrollo sin conexión nativa. Vinculación y terminal requieren Android; no se usan datos ficticios.') }, [native, loadProfiles])
  const refresh = useCallback(async () => {
    const id = active.current, version = ++generation.current; if (!id) return; setStatus('connecting')
    try {
      const data = await api<MobileBootstrap>(id, '/api/v1/bootstrap'); if (active.current !== id || generation.current !== version) return
      if (data.version !== 1 || !data.device || !Array.isArray(data.projects) || !Array.isArray(data.hosts)) throw new Error('Protocolo incompatible con este companion.')
      setBootstrap(data); setProfiles(previous => previous.map(item => item.id === id ? { ...item, device: data.device } : item)); setHostId(previous => data.hosts.some(host => host.id === previous) ? previous : data.hosts[0]?.id || ''); setStatus('connected'); setError('')
      const authorizedNotices = await api<MobileNotice[]>(id, '/api/v1/notices'); if (active.current !== id || generation.current !== version) return; setNotices(authorizedNotices)
      if (data.device.capabilities.quotas) { const dataQuotas = await api<MobileQuota[]>(id, '/api/v1/quotas'); if (active.current === id && generation.current === version) setQuotas(dataQuotas) }
    } catch (reason) { if (active.current === id && generation.current === version) fail(message(reason)) }
  }, [fail])
  useEffect(() => { if (profileId) void refresh() }, [profileId, refresh])
  useEffect(() => {
    if (!profileId || !hostId || !bootstrap) return
    let cancelled = false; const id = profileId, version = generation.current
    void api<MobileSession[]>(id, `/api/v1/sessions?hostId=${encodeURIComponent(hostId)}`).then(result => { if (!cancelled && active.current === id && generation.current === version) setSessions(result) }).catch(reason => { if (!cancelled && active.current === id && generation.current === version) fail(message(reason)) })
    return () => { cancelled = true }
  }, [profileId, hostId, bootstrap, fail])
  back.current = () => {
    const dialog = document.querySelector('dialog[open]'); if (dialog) { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); return }
    if (terminal) setTerminal(null); else if (enrolling) setEnrolling(false); else if (page !== 'Inicio') setPage('Inicio'); else void App.minimizeApp()
  }
  useEffect(() => {
    if (!native) return
    const handles: { remove(): Promise<void> }[] = []; let disposed = false
    async function setup() {
      handles.push(await App.addListener('backButton', () => back.current()))
      handles.push(await App.addListener('appStateChange', state => { generation.current++; if (state.isActive) { void loadProfiles(); void refresh() } else setStatus('disconnected') }))
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
  async function openNotice(notice: MobileNotice) {
    const id = profileId, version = generation.current
    try { const allowed = await api<MobileSession[]>(id, `/api/v1/sessions?hostId=${encodeURIComponent(notice.hostId)}`); if (active.current !== id || version !== generation.current) return; const session = allowed.find(item => item.id === notice.sessionId); if (!session) throw new Error('Esta sesión ya no está disponible o autorizada.'); setHostId(notice.hostId); setSessions(allowed); setTerminal(session) }
    catch (reason) { if (active.current === id && version === generation.current) fail(message(reason)) }
  }
  return <div className={`app ${terminal ? 'with-terminal' : ''}`}>
    <header><div><span className="brand">CROW</span><h1>{terminal ? 'Terminal' : enrolling ? 'Vincular Windows' : page}</h1></div><button aria-label="Actualizar conexión con Windows" disabled={!profile || busy} onClick={() => void refresh()}><RefreshCw size={22} aria-hidden="true" /></button></header>
    {error && <p className="error" role="alert">{error}</p>}
    {terminal && profile ? <TerminalView profile={profile} hostId={hostId} session={terminal} onBack={() => setTerminal(null)} onError={fail} onState={info => setTerminal(previous => previous && previous.id === info.id ? { ...previous, ...info } : previous)} /> : <main>
      {enrolling ? <Enrollment onCancel={() => setEnrolling(false)} onError={setError} onPaired={value => { profileListGeneration.current++; setProfiles(previous => [...previous, value]); changeProfile(value.id); setEnrolling(false); setPage('Inicio') }} /> : <>
        <section className="connection"><span className={`dot ${status}`} aria-hidden="true" /><div><strong>{profile ? profile.device.label : 'Sin Windows vinculado'}</strong><small>{status === 'connected' ? 'Windows conectado · Crow abierto' : status === 'connecting' ? 'Conectando…' : status === 'revoked' ? 'Revocado o vencido · revinculá' : 'Sin conexión · Windows debe estar despierto'}</small></div></section>
        {!profile && <section className="card"><h2>Tu workspace, desde Android</h2><p>Vinculá Crow abierto en Windows. Las sesiones siguen ejecutándose allí y en tus hosts Linux. Android no guarda claves SSH ni conecta directo a Linux.</p><button className="primary" disabled={!native} onClick={() => setEnrolling(true)}>Vincular con QR</button><p>El acceso individual debe estar habilitado en Crow antes de generar la invitación.</p></section>}
        {profile && page === 'Inicio' && <>
          <section className="card"><h2>Sesiones de {bootstrap?.actor.label || 'tu cuenta'}</h2>{sessions.length ? sessions.slice(0, 4).map(session => <SessionRow key={session.id} session={session} disabled={status !== 'connected'} onOpen={() => setTerminal(session)} />) : <p>{status === 'connected' ? 'No hay sesiones en este host.' : 'Conectate para ver el estado real de las sesiones.'}</p>}<button onClick={() => setPage('Proyectos')}>Ver proyectos</button></section>
          <section className="card"><h2>Cuotas</h2>{!bootstrap?.device.capabilities.quotas ? <p>No autorizadas para este dispositivo. Podés habilitarlas al vincular desde Windows.</p> : !quotas.length ? <p>No hay muestras disponibles. No se interpreta como 0 %.</p> : quotas.map((quota) => <div className="quota" key={quota.id}><strong>{quota.label} · {agentLabel(quota.provider)} · {quotaStateLabel(quota.state)}</strong><small>{quota.sampledAt ? `Muestra: ${new Date(quota.sampledAt).toLocaleString()}` : 'Sin timestamp'}{staleQuota(quota.sampledAt) ? ' · desactualizada' : ''}</small>{quota.windows.map(window => <p key={window.label}>{window.label}: {window.usedPercent === null ? 'no disponible' : `${window.usedPercent} % usado`}{window.resetsAt ? ` · renueva ${new Date(window.resetsAt).toLocaleString()}` : ''}</p>)}</div>)}</section>
        </>}
        {profile && page === 'Proyectos' && <>
          <label htmlFor="host">Host</label><select id="host" value={hostId} onChange={event => { setHostId(event.target.value); setSessions([]) }}>{bootstrap?.hosts.map(host => <option value={host.id} key={host.id}>{host.name} · {hostStateLabel(host.status)}</option>)}</select>
          <label htmlFor="search">Buscar proyectos</label><input id="search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Nombre del proyecto" />
          {bootstrap?.projects.filter(project => project.hostId === hostId && project.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(project => <section className="card" key={project.id}><h2>{project.name}</h2>{sessions.filter(session => session.projectId === project.id).map(session => <div key={session.id}><SessionRow session={session} disabled={status !== 'connected'} onOpen={() => setTerminal(session)} />{session.canOperate && !session.readOnly && <div className="row">{mayWake(session, bootstrap.device) && <button disabled={busy || status !== 'connected'} onClick={() => void mutate('/api/v1/wake', { hostId, sessionId: session.id }, value => { setSessions(previous => previous.map(item => item.id === value.id ? value : item)); setTerminal(value) })}>Despertar</button>}{bootstrap.device.capabilities.close && <button className="danger" disabled={busy || status !== 'connected'} onClick={() => setClosing(session)}>Cerrar proceso…</button>}</div>}</div>)}<button className="primary" disabled={busy || status !== 'connected' || !bootstrap.device.capabilities.create} onClick={() => setNewProject(project)}>Nueva sesión</button>{!bootstrap.device.capabilities.create && <small>Tu dispositivo no puede crear sesiones.</small>}</section>)}
          {bootstrap && !bootstrap.projects.some(project => project.hostId === hostId) && <p>No hay proyectos autorizados en este host.</p>}
        </>}
        {profile && page === 'Alertas' && <section className="card"><h2>Actividad autorizada</h2><p>Se actualiza al volver a la app o tocar ↻. Sin notificaciones de fondo en esta versión.</p>{notices.length ? notices.map(notice => <button className="notice" disabled={status !== 'connected'} key={notice.id} onClick={() => void openNotice(notice)}><span>{notice.kind === 'turn-complete' ? 'Turno completado' : 'Proceso finalizado'}{notice.requiresAttention ? ' · requiere atención' : ''}<small>{new Date(notice.at).toLocaleString()}</small></span><span aria-hidden="true">→</span></button>) : <p>No hay avisos disponibles.</p>}</section>}
        {page === 'Ajustes' && <>
          <section className="card"><h2>Gateways Windows</h2>{profiles.map(item => <div className="profile" key={item.id}><button aria-pressed={item.id === profileId} onClick={() => { if (item.id === profileId) void refresh(); else changeProfile(item.id) }}><strong>{item.device.label}</strong><small>{item.endpoint.kind === 'lan-pinned' ? 'LAN · certificado fijado' : 'Remoto · CA del sistema'} · {item.endpoint.url}</small><small>Vence {new Date(item.device.expiresAt).toLocaleString()}</small></button><button className="danger" onClick={() => { generation.current++; profileListGeneration.current++; void Gateway.deleteProfile({ profileId: item.id }).then(() => { setProfiles(previous => previous.filter(value => value.id !== item.id)); if (active.current === item.id) changeProfile('') }).catch(reason => fail(message(reason))) }}>Olvidar dispositivo</button></div>)}<button disabled={!native} className="primary" onClick={() => setEnrolling(true)}>Vincular otro Windows</button></section>
          <section className="card"><h2>Seguridad</h2><p>Invitaciones de un solo uso. El token del dispositivo queda cifrado con Android Keystore y nunca llega a JavaScript. Vínculos vencidos, revocados o reinicio del gateway requieren revinculación explícita.</p><p>Sin integración ERP ni notificaciones FCM de fondo en esta versión.</p></section>
        </>}
      </>}
    </main>}
    {!terminal && !enrolling && <nav aria-label="Navegación principal">{(['Inicio', 'Proyectos', 'Alertas', 'Ajustes'] as Page[]).map((name, index) => <button aria-current={page === name ? 'page' : undefined} key={name} onClick={() => setPage(name)}><NavIcon index={index} />{name}</button>)}</nav>}
    {newProject && <CreateSession project={newProject} busy={busy} onCancel={() => setNewProject(null)} onCreate={agent => void mutate('/api/v1/sessions', { hostId: newProject.hostId, projectId: newProject.id, agent }, session => { setSessions(previous => [...previous, session]); setTerminal(session); setNewProject(null) })} />}
    {closing && <ConfirmClose session={closing} busy={busy} onCancel={() => setClosing(null)} onConfirm={() => void mutate('/api/v1/close', { hostId, sessionId: closing.id }, () => { setSessions(previous => previous.filter(session => session.id !== closing.id)); setClosing(null) })} />}
  </div>
}
function SessionRow({ session, disabled, onOpen }: { session: MobileSession; disabled: boolean; onOpen(): void }) { return <button className="session" disabled={disabled} onClick={onOpen}><span><strong>{agentLabel(session.agent)} · {session.name || session.id.slice(0, 8)}</strong><small>{sessionStateLabel(session.state)} · {agentStateLabel(session.agentState)}{!session.canOperate || session.readOnly ? ' · solo lectura' : ''}</small></span><span aria-hidden="true">→</span></button> }
function Enrollment({ onCancel, onError, onPaired }: { onCancel(): void; onError(message: string): void; onPaired(profile: GatewayProfile): void }) {
  const [raw, setRaw] = useState(''), [invitation, setInvitation] = useState<MobileEnrollment | null>(null), [index, setIndex] = useState(0), [label, setLabel] = useState('Mi Android'), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false)
  const endpoint = invitation?.endpoints[index]
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  function review(value: string) { try { const parsed = parseEnrollment(value) as MobileEnrollment; setInvitation(parsed); setRaw(''); setIndex(0); setConfirmed(false) } catch (error) { onError(message(error)) } }
  async function scan() {
    setBusy(true)
    try { const result = await CapacitorBarcodeScanner.scanBarcode({ hint: 0, scanInstructions: 'Escaneá la invitación de Crow en Windows', scanButton: false, cameraDirection: 1, scanOrientation: 3 }); if (mounted.current && result.ScanResult) review(result.ScanResult) }
    catch { onError('No se pudo escanear o no se autorizó la cámara. Podés pegar el JSON de invitación o importar su archivo.') }
    finally { setBusy(false) }
  }
  async function pair() {
    if (!invitation || !endpoint) return; setBusy(true)
    try { const result = await Gateway.pair({ enrollment: invitation, endpointIndex: index, deviceName: label, fingerprintConfirmed: confirmed }); if (!mounted.current) { await Gateway.deleteProfile({ profileId: result.profile.id }); return } setInvitation(null); onPaired(result.profile) }
    catch (error) { if (mounted.current) onError(message(error)) } finally { if (mounted.current) setBusy(false) }
  }
  return <section className="card"><button onClick={onCancel} disabled={busy}>← Volver</button><h2>{invitation ? 'Confirmá la conexión' : 'Vincular con Crow en Windows'}</h2>
    {!invitation ? <><p>En Windows, habilitá acceso individual, abrí Ajustes → Android y generá una invitación. No compartas el código.</p><button className="primary" disabled={busy} onClick={() => void scan()}>Escanear QR con cámara</button><label htmlFor="invite">Invitación JSON</label><textarea id="invite" rows={5} value={raw} onChange={event => setRaw(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Pegá la invitación completa, no una URL" /><button disabled={!raw || busy} onClick={() => review(raw)}>Revisar invitación</button><label htmlFor="import">O importar archivo de invitación</label><input id="import" type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; if (file && file.size <= 32768) void file.text().then(review); else onError('El archivo de invitación debe ser JSON de hasta 32 KiB.') }} /></> : <>
      <label htmlFor="endpoint">Conectarte por</label><select id="endpoint" value={index} onChange={event => { setIndex(Number(event.target.value)); setConfirmed(false) }}>{invitation.endpoints.map((item, i) => <option key={`${item.url}-${i}`} value={i}>{item.kind === 'lan-pinned' ? 'LAN local' : 'Remoto HTTPS'} · {item.url}</option>)}</select><p className="break">{endpoint?.url}</p>
      {endpoint?.kind === 'lan-pinned' ? <><p>Compará ESTA huella con la que muestra Crow en Windows. No confirmes si difiere.</p><code className="fingerprint">{endpoint.certSHA256}</code><label className="check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />La huella coincide con Windows</label></> : <p>Remoto usa confianza de la CA del sistema. Crow debe tener configurado exactamente este origen público; no se siguen redirecciones.</p>}
      <label htmlFor="device-label">Nombre de este dispositivo</label><input id="device-label" maxLength={80} value={label} onChange={event => setLabel(event.target.value)} /><button className="primary" disabled={busy || !label.trim() || endpoint?.kind === 'lan-pinned' && !confirmed} onClick={() => void pair()}>{busy ? 'Vinculando…' : 'Confirmar vínculo'}</button><button disabled={busy} onClick={() => setInvitation(null)}>Usar otra invitación</button>
    </>}
  </section>
}
function CreateSession({ project, busy, onCancel, onCreate }: { project: MobileProject; busy: boolean; onCancel(): void; onCreate(agent: 'claude' | 'codex'): void }) {
  const dialog = useRef<HTMLDialogElement>(null); const [agent, setAgent] = useState<'claude' | 'codex'>('claude'), [review, setReview] = useState(false)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return <dialog ref={dialog} aria-labelledby="create-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}><h2 id="create-title">{review ? 'Revisá la sesión' : 'Nueva sesión'}</h2><p>Proyecto: <strong>{project.name}</strong></p>{review ? <p>{agentLabel(agent)} · modo normal · sin permisos peligrosos. El proceso se creará desde Windows en el host configurado.</p> : <><label htmlFor="agent">Agente</label><select autoFocus id="agent" value={agent} onChange={event => setAgent(event.target.value as 'claude' | 'codex')}><option value="claude">Claude</option><option value="codex">Codex</option></select></>}<div className="row"><button disabled={busy} onClick={review ? () => setReview(false) : onCancel}>{review ? 'Atrás' : 'Cancelar'}</button><button disabled={busy} className="primary" onClick={review ? () => onCreate(agent) : () => setReview(true)}>{busy ? 'Creando…' : review ? 'Crear sesión' : 'Revisar'}</button></div></dialog>
}
function ConfirmClose({ session, busy, onCancel, onConfirm }: { session: MobileSession; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null); useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return <dialog ref={dialog} aria-labelledby="close-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}><h2 id="close-title">¿Cerrar el proceso?</h2><p>Terminará {agentLabel(session.agent)} en este proyecto. Para salir de la terminal sin detenerlo, usá Volver.</p><div className="row"><button autoFocus disabled={busy} onClick={onCancel}>Cancelar</button><button className="danger" disabled={busy} onClick={onConfirm}>Cerrar proceso</button></div></dialog>
}
function viewport() { document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`) }
window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport()
createRoot(document.getElementById('root')!).render(<MobileApp />)
