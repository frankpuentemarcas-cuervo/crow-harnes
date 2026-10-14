import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Host, MobileStatus, Project } from '../../shared/types'
import type { MobileCapabilities, MobileEnrollmentMetadata, MobileRemoteProvider } from '../../shared/mobile-companion'
import { mobilePairingURL } from '../../shared/mobile-pairing'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'

const defaults: MobileCapabilities = { input: false, create: false, close: false, quotas: false }
const labels: Record<keyof MobileCapabilities, string> = { input: 'Enviar entrada y reanudar', create: 'Crear terminales Claude / Codex', close: 'Cerrar procesos de terminal', quotas: 'Compartir cuotas de cuentas de Windows' }

export function MobileDialog({ projects, hosts, onClose }: { projects: Project[]; hosts: Host[]; onClose(): void }): React.JSX.Element {
  const [status, setStatus] = useState<MobileStatus>({ running: false })
  const [addresses, setAddresses] = useState<string[]>([])
  const [address, setAddress] = useState('')
  const [publicOrigin, setPublicOrigin] = useState('')
  const [relayUrl, setRelayUrl] = useState('')
  const [provider, setProvider] = useState<MobileRemoteProvider>('tailscale')
  const [loopbackPort, setLoopbackPort] = useState('47323')
  const [pangolinTokenId, setPangolinTokenId] = useState('')
  const [pangolinToken, setPangolinToken] = useState('')
  const [showPangolinToken, setShowPangolinToken] = useState(false)
  const [projectIds, setProjectIds] = useState<string[]>(projects.map(project => project.id))
  const [capabilities, setCapabilities] = useState(defaults)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorFocusRequest, setErrorFocusRequest] = useState(0)
  const [notice, setNotice] = useState('')
  const [qr, setQR] = useState('')
  const [qrEnrollment, setQREnrollment] = useState<MobileEnrollmentMetadata | null>(null)
  const [now, setNow] = useState(Date.now())
  const projectIdsKey = JSON.stringify(projects.map(project => project.id).sort())
  const working = useRef(false)
  const errorFocus = useRef<HTMLDivElement>(null)
  const confirm = useConfirm()
  useLayoutEffect(() => {
    if (errorFocusRequest) errorFocus.current?.focus()
  }, [errorFocusRequest])
  useEffect(() => {
    let live = true
    void Promise.all([window.crow.mobileAddresses(), window.crow.mobileStatus()]).then(([items, current]) => {
      if (!live) return
      setAddresses(items); setAddress(items[0] || ''); setStatus(current)
      setPublicOrigin(current.enrollment?.endpoints.find(item => item.kind === 'remote-public')?.url || '')
      setRelayUrl(current.relayUrl || current.enrollment?.endpoints.find(item => item.kind === 'relay')?.relayUrl || '')
      setProvider(current.remoteProvider || 'tailscale')
      if (current.remoteProvider === 'pangolin' && current.loopbackUrl) setLoopbackPort(new URL(current.loopbackUrl).port)
    }).catch(reason => { if (live) setError(String(reason)) })
    return () => { live = false }
  }, [])
  useEffect(() => { setProjectIds(JSON.parse(projectIdsKey) as string[]) }, [projectIdsKey])
  useEffect(() => {
    let live = true
    const timer = setInterval(() => {
      setNow(Date.now())
      if (!working.current) void window.crow.mobileStatus().then(value => { if (live) setStatus(value) }).catch(() => undefined)
    }, 1500)
    return () => { live = false; clearInterval(timer) }
  }, [])
  const pendingEnrollment = status.enrollment
  const expired = !qrEnrollment || Date.parse(qrEnrollment.expiresAt) <= now
  const pendingExpired = !pendingEnrollment || Date.parse(pendingEnrollment.expiresAt) <= now
  useEffect(() => {
    if (qrEnrollment && expired) { setQREnrollment(null); setQR('') }
  }, [qrEnrollment, expired])

  async function run(operation: () => Promise<void>): Promise<void> {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (reason) { setError(String(reason)); setErrorFocusRequest(current => current + 1) }
    finally { working.current = false; setBusy(false) }
  }
  async function toggle(): Promise<void> {
    if (status.running && !await confirm({ message: 'Pausar el gateway desconecta el acceso móvil y cancela las invitaciones. Conserva la confianza de los dispositivos hasta revocación; los vínculos antiguos mantienen su vencimiento. No cierra las terminales.', accept: 'Pausar acceso', danger: false })) return
    await run(async () => {
      if (status.running) { setQREnrollment(null); setQR(''); setPangolinTokenId(''); setPangolinToken(''); setStatus(await window.crow.mobileStop()) }
      else setStatus(await window.crow.mobileStart({ address, ...(publicOrigin.trim() ? { publicOrigin: publicOrigin.trim() } : {}), ...(provider === 'pangolin' ? { remoteProvider: provider, loopbackPort: Number(loopbackPort) } : {}), relayUrl: relayUrl.trim() }))
      setNotice(status.running ? 'Acceso pausado. Reanudá el gateway para usar los dispositivos cuyo vínculo siga vigente.' : 'Gateway activo. Los dispositivos con vínculo vigente pueden reconectarse; para uno nuevo, generá una invitación.')
    })
  }
  async function invite(): Promise<void> {
    await run(async () => {
      const next = await window.crow.mobileInvite({ projectIds, capabilities, ...((status.remoteProvider ?? provider) === 'pangolin' ? { pangolinAuth: { tokenId: pangolinTokenId, token: pangolinToken } } : {}) })
      setQREnrollment(next.enrollment); setQR(next.qrDataUrl); setPangolinTokenId(''); setPangolinToken(''); setShowPangolinToken(false)
      setNotice('Invitación creada. Verificá el dominio y el nombre del teléfono al vincular.')
    })
  }
  async function revoke(id: string, label: string): Promise<void> {
    if (!await confirm({ message: `¿Revocar el dispositivo «${label}»? Se desconectará inmediatamente y deberá vincularse otra vez.`, accept: 'Revocar', danger: true })) return
    await run(async () => { setStatus(await window.crow.mobileRevoke(id)); setNotice('Dispositivo revocado.') })
  }

  return <Modal className="mobile-dialog" titleId="mobile-title" busy={busy} initialFocus="[data-close]" onClose={onClose}>
    <div className="dialog-heading"><h2 id="mobile-title">Acceso móvil · Android</h2><button data-close className="icon-button" aria-label="Cerrar" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <p>Windows debe estar encendido, sin suspensión, con Crow y el túnel SSH activos. Android no recibe llaves SSH ni credenciales de Claude/Codex. Si elegís Pangolin, el QR sí lleva el token del recurso junto con la invitación temporal.</p>
    <p className="mobile-security-note">Los vínculos se guardan cifrados en Windows y se conservan al reiniciar Crow. Las nuevas vinculaciones Android usan una clave protegida: la confianza dura hasta revocación o cambio de identidad/permisos; las credenciales de acceso vencen a los 15 minutos y se renuevan con una prueba firmada. Los vínculos antiguos conservan su vencimiento de 12 horas y necesitan una nueva invitación para migrar. Si cambia la IP de Windows, puede hacer falta una nueva invitación LAN.</p>
    {!status.running && Boolean(status.devices?.length) && <p role="status">Acceso pausado. Los dispositivos vinculados no pueden conectarse hasta que reanudes el gateway.</p>}
    {!status.running && <><label htmlFor="mobile-address">IPv4 privada de este equipo</label><select id="mobile-address" disabled={busy} value={address} onChange={event => setAddress(event.target.value)}>{addresses.map(item => <option key={item}>{item}</option>)}</select>
      <label htmlFor="mobile-relay-url">Relay E2E · WSS (opcional)</label><input id="mobile-relay-url" disabled={busy} type="url" placeholder="wss://relay.ejemplo.com/v1/tunnel" value={relayUrl} onChange={event => setRelayUrl(event.target.value)} />
      <small>Usa un relay Crow compatible. El relay solo reenvía bytes TLS cifrados; las credenciales y permisos se validan en Windows. La invitación incluye un localizador aleatorio: no compartas el QR. Esto no instala ni publica el servidor remoto.</small>
      {!addresses.length && <p>No se detectó una IPv4 privada. Conectá Windows a una red local confiable.</p>}
      <label htmlFor="mobile-provider">Proveedor remoto manual</label><select id="mobile-provider" disabled={busy} value={provider} onChange={event => { setProvider(event.target.value as MobileRemoteProvider); setPublicOrigin(''); setPangolinTokenId(''); setPangolinToken('') }}><option value="tailscale">Tailscale Serve</option><option value="pangolin">Pangolin · doble autenticación</option></select>
      <label htmlFor="mobile-origin">{provider === 'pangolin' ? 'Dominio HTTPS público exacto de Pangolin' : 'Endpoint HTTPS de Tailscale Serve (opcional)'}</label><input id="mobile-origin" disabled={busy} type="url" placeholder={provider === 'pangolin' ? 'https://crow.ejemplo.com' : 'https://equipo.tailnet.ts.net'} value={publicOrigin} onChange={event => setPublicOrigin(event.target.value)} />
      {provider === 'pangolin' && <><label htmlFor="mobile-port">Puerto backend fijo para Newt · solo 127.0.0.1</label><input id="mobile-port" disabled={busy} type="number" min="1024" max="65535" step="1" value={loopbackPort} onChange={event => setLoopbackPort(event.target.value)} /></>}</>}
    <p className="mobile-security-note">{provider === 'pangolin' ? 'Configuración manual: Crow NO instala ni configura Newt, Pangolin, TLS o recursos; tampoco comprueba la conexión. Reenviá HTTPS/WSS al backend indicado y mantené la autenticación Pangolin por recurso. Para el QR vas a ingresar el ID/token de acceso de ESE recurso.' : 'El endpoint remoto es configuración manual: guardarlo NO crea ni comprueba un túnel. Configurá Tailscale Serve en tu tailnet para reenviar al backend local que se muestra al iniciar; no uses Funnel ni publiques puertos del router.'}</p>
    {status.running && <><div className="mobile-credentials"><div><strong>LAN · HTTPS fijado por huella</strong><code>{status.url}</code></div>{status.loopbackUrl && <div><strong>Backend remoto · solo loopback</strong><code>{status.loopbackUrl}</code></div>}{status.relayUrl && <div><strong>Relay E2E · {status.relayState === 'connected' ? 'conectado' : status.relayState === 'reconnecting' ? 'reconectando' : 'conectando'}</strong><code>{status.relayUrl}</code></div>}</div>
      <div className="mobile-fingerprint"><strong>Huella SHA-256 del certificado LAN</strong><code>{status.fingerprint}</code></div>
      <p>Android compara esta huella antes de enviar el código. Un cambio de huella exige una nueva vinculación. El endpoint remoto usa certificados HTTPS de confianza, no una excepción global.</p>
      {(status.remoteProvider ?? provider) === 'pangolin' && <fieldset disabled={busy} className="mobile-pangolin-fields"><legend>Credenciales Pangolin · requeridas para generar el QR</legend><label htmlFor="mobile-pangolin-token-id">ID del token de acceso del recurso</label><input id="mobile-pangolin-token-id" required aria-required="true" autoComplete="off" maxLength={128} spellCheck={false} value={pangolinTokenId} onChange={event => setPangolinTokenId(event.target.value)} /><label htmlFor="mobile-pangolin-token">Token de acceso del recurso</label><div className="mobile-pangolin-token"><input id="mobile-pangolin-token" required aria-required="true" autoComplete="new-password" maxLength={1024} spellCheck={false} type={showPangolinToken ? 'text' : 'password'} value={pangolinToken} onChange={event => setPangolinToken(event.target.value)} /><button type="button" className="secondary-button" aria-pressed={showPangolinToken} onClick={() => setShowPangolinToken(value => !value)}>{showPangolinToken ? 'Ocultar' : 'Mostrar'}</button></div><small>El QR incluirá estas credenciales. Quien obtenga el QR antes que vos podría vincular un teléfono con los permisos seleccionados. Usá un token con vencimiento corto, no compartas capturas y revocalo en Pangolin después de vincular.</small></fieldset>}
      <fieldset disabled={busy}><legend>Proyectos para esta invitación · {projectIds.length} seleccionados</legend><div className="mobile-project-actions"><button type="button" onClick={() => setProjectIds(JSON.parse(projectIdsKey) as string[])}>Seleccionar todos</button><button type="button" onClick={() => setProjectIds([])}>Quitar selección</button></div>{projects.map(project => <label key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={event => setProjectIds(current => event.target.checked ? [...current, project.id] : current.filter(id => id !== project.id))} /> {hosts.find(host => host.id === project.hostId)?.name || project.hostId} · {project.name}</label>)}</fieldset>
      <fieldset disabled={busy}><legend>Permisos del dispositivo · solo lectura por defecto</legend>{(Object.keys(labels) as (keyof MobileCapabilities)[]).map(key => <label key={key}><input type="checkbox" checked={capabilities[key]} onChange={event => setCapabilities(current => ({ ...current, [key]: event.target.checked }))} /> {labels[key]}</label>)}</fieldset>
      <p>Todos los proyectos quedan seleccionados inicialmente. Si un servidor está desconectado, la invitación igual se crea y Android lo marcará como no disponible; no se habilita acceso hasta que el host pueda validar tu identidad. Cuotas es una autorización separada.</p>
      <button className="primary-button" disabled={busy || !projectIds.length || ((status.remoteProvider ?? provider) === 'pangolin' && (!pangolinTokenId || !pangolinToken))} onClick={() => void invite()}>{qrEnrollment || pendingEnrollment ? 'Renovar invitación' : 'Generar invitación Android'}</button>
      {qrEnrollment && !expired && <div className="mobile-qr-panel"><strong>Importá este QR desde Crow Android</strong>{qr ? <img src={qr} width="384" height="384" alt="Invitación Android temporal; incluye credenciales del recurso si usa Pangolin" /> : <span role="status">Generando QR…</span>}<small>Vence: {new Date(qrEnrollment.expiresAt).toLocaleTimeString()}. No compartas el QR ni capturas: incluye el código de vínculo y el token Pangolin.</small></div>}
      {!qrEnrollment && pendingEnrollment && !pendingExpired && <p role="status">La invitación activa no está disponible en esta ventana. Generá otra para mostrar un nuevo QR.</p>}
      {qrEnrollment && expired && <p role="status">La invitación venció. Generá una nueva; el código de Crow nunca se reutiliza.</p>}
      {status.url && status.pairingCode && <details><summary>Navegador LAN anterior</summary><p>Verificá la huella en el navegador antes de aceptar el certificado autofirmado.</p><a href={mobilePairingURL(status.url, status.pairingCode)} target="_blank" rel="noreferrer">Abrir emparejamiento LAN de un solo uso</a></details>}
    </>}
    <h3>Dispositivos vinculados</h3>{!status.devices?.length && <p>Ningún dispositivo vinculado. Confirmá el nombre al completar la vinculación.</p>}{status.devices?.map(device => <div key={device.id} className="mobile-credentials"><div><strong>{device.label}</strong><small>{device.expiresAt === null ? 'Confianza hasta revocación' : `Vínculo antiguo · vence ${new Date(device.expiresAt).toLocaleString()}`} · {device.projectIds.length + (device.unavailableProjects?.length || 0)} proyectos</small><small>{device.capabilities.input ? 'Entrada habilitada' : 'Solo lectura'} · Cuotas {device.capabilities.quotas ? 'compartidas' : 'ocultas'}</small></div><button className="danger-button" disabled={busy} onClick={() => void revoke(device.id, device.label)}>Revocar dispositivo</button></div>)}
    {notice && <p role="status">{notice}</p>}{error && <div ref={errorFocus} tabIndex={-1} className="inline-error" role="alert">{error}</div>}
    <div className="dialog-actions"><span /><button className="secondary-button" disabled={busy} onClick={onClose}>Cerrar</button><button className={status.running ? 'secondary-button' : 'primary-button'} disabled={busy || (!status.running && !address)} onClick={() => void toggle()}>{busy ? 'Aplicando…' : status.running ? 'Pausar acceso' : status.devices?.length ? 'Reanudar acceso' : 'Activar gateway'}</button></div>
  </Modal>
}
