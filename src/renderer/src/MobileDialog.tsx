import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { X } from 'lucide-react'
import type { Host, MobileStatus, Project } from '../../shared/types'
import type { MobileCapabilities, MobileRemoteProvider } from '../../shared/mobile-companion'
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
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [capabilities, setCapabilities] = useState(defaults)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorFocusRequest, setErrorFocusRequest] = useState(0)
  const [notice, setNotice] = useState('')
  const [qr, setQR] = useState('')
  const [now, setNow] = useState(Date.now())
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
  useEffect(() => {
    let live = true
    const timer = setInterval(() => {
      setNow(Date.now())
      if (!working.current) void window.crow.mobileStatus().then(value => { if (live) setStatus(value) }).catch(() => undefined)
    }, 1500)
    return () => { live = false; clearInterval(timer) }
  }, [])
  const enrollment = status.enrollment
  const expired = !enrollment || Date.parse(enrollment.expiresAt) <= now
  useEffect(() => {
    setQR('')
    if (!status.running || !enrollment || expired) return
    let live = true
    void QRCode.toDataURL(JSON.stringify(enrollment), { width: 256, margin: 2, errorCorrectionLevel: 'M' }).then(value => { if (live) setQR(value) }).catch(reason => { if (live) setError(`No se pudo generar el QR: ${String(reason)}`) })
    return () => { live = false }
  }, [status.running, enrollment?.invitationCode, expired])

  async function run(operation: () => Promise<void>): Promise<void> {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (reason) { setError(String(reason)); setErrorFocusRequest(current => current + 1) }
    finally { working.current = false; setBusy(false) }
  }
  async function toggle(): Promise<void> {
    if (status.running && !await confirm({ message: 'Pausar el gateway desconecta el acceso móvil y cancela las invitaciones. Conserva la confianza de los dispositivos hasta revocación; los vínculos antiguos mantienen su vencimiento. No cierra las terminales.', accept: 'Pausar acceso', danger: false })) return
    await run(async () => {
      setStatus(status.running ? await window.crow.mobileStop() : await window.crow.mobileStart({ address, ...(publicOrigin.trim() ? { publicOrigin: publicOrigin.trim() } : {}), ...(provider === 'pangolin' ? { remoteProvider: provider, loopbackPort: Number(loopbackPort) } : {}), relayUrl: relayUrl.trim() }))
      setNotice(status.running ? 'Acceso pausado. Reanudá el gateway para usar los dispositivos cuyo vínculo siga vigente.' : 'Gateway activo. Los dispositivos con vínculo vigente pueden reconectarse; para uno nuevo, generá una invitación.')
    })
  }
  async function invite(): Promise<void> {
    await run(async () => {
      const next = await window.crow.mobileInvite({ projectIds, capabilities })
      setStatus(current => ({ ...current, enrollment: next })); setNotice('Invitación creada. Verificá la huella y el nombre del teléfono al vincular.')
    })
  }
  async function revoke(id: string, label: string): Promise<void> {
    if (!await confirm({ message: `¿Revocar el dispositivo «${label}»? Se desconectará inmediatamente y deberá vincularse otra vez.`, accept: 'Revocar', danger: true })) return
    await run(async () => { setStatus(await window.crow.mobileRevoke(id)); setNotice('Dispositivo revocado.') })
  }

  return <Modal className="mobile-dialog" titleId="mobile-title" busy={busy} initialFocus="[data-close]" onClose={onClose}>
    <div className="dialog-heading"><h2 id="mobile-title">Acceso móvil · Android</h2><button data-close className="icon-button" aria-label="Cerrar" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <p>Windows debe estar encendido, sin suspensión, con Crow y el túnel SSH activos. Android no recibe tus llaves SSH ni credenciales de proveedores.</p>
    <p className="mobile-security-note">Los vínculos se guardan cifrados en Windows y se conservan al reiniciar Crow. Las nuevas vinculaciones Android usan una clave protegida: la confianza dura hasta revocación o cambio de identidad/permisos; las credenciales de acceso vencen a los 15 minutos y se renuevan con una prueba firmada. Los vínculos antiguos conservan su vencimiento de 12 horas y necesitan una nueva invitación para migrar. Si cambia la IP de Windows, puede hacer falta una nueva invitación LAN.</p>
    {!status.running && Boolean(status.devices?.length) && <p role="status">Acceso pausado. Los dispositivos vinculados no pueden conectarse hasta que reanudes el gateway.</p>}
    {!status.running && <><label htmlFor="mobile-address">IPv4 privada de este equipo</label><select id="mobile-address" disabled={busy} value={address} onChange={event => setAddress(event.target.value)}>{addresses.map(item => <option key={item}>{item}</option>)}</select>
      <label htmlFor="mobile-relay-url">Relay E2E · WSS (opcional)</label><input id="mobile-relay-url" disabled={busy} type="url" placeholder="wss://relay.ejemplo.com/v1/tunnel" value={relayUrl} onChange={event => setRelayUrl(event.target.value)} />
      <small>Usa un relay Crow compatible. El relay solo reenvía bytes TLS cifrados; las credenciales y permisos se validan en Windows. La invitación incluye un localizador aleatorio: no compartas el QR. Esto no instala ni publica el servidor remoto.</small>
      {!addresses.length && <p>No se detectó una IPv4 privada. Conectá Windows a una red local confiable.</p>}
      <label htmlFor="mobile-provider">Proveedor remoto manual</label><select id="mobile-provider" disabled={busy} value={provider} onChange={event => { setProvider(event.target.value as MobileRemoteProvider); setPublicOrigin('') }}><option value="tailscale">Tailscale Serve</option><option value="pangolin">Pangolin · doble autenticación</option></select>
      <label htmlFor="mobile-origin">{provider === 'pangolin' ? 'Dominio HTTPS público exacto de Pangolin' : 'Endpoint HTTPS de Tailscale Serve (opcional)'}</label><input id="mobile-origin" disabled={busy} type="url" placeholder={provider === 'pangolin' ? 'https://crow.ejemplo.com' : 'https://equipo.tailnet.ts.net'} value={publicOrigin} onChange={event => setPublicOrigin(event.target.value)} />
      {provider === 'pangolin' && <><label htmlFor="mobile-port">Puerto backend fijo para Newt · solo 127.0.0.1</label><input id="mobile-port" disabled={busy} type="number" min="1024" max="65535" step="1" value={loopbackPort} onChange={event => setLoopbackPort(event.target.value)} /></>}</>}
    <p className="mobile-security-note">{provider === 'pangolin' ? 'Configuración manual: Crow NO instala ni configura Newt, Pangolin, TLS o recursos; tampoco comprueba la conexión. Reenviá HTTPS/WSS al backend indicado. Mantené autenticación Pangolin por recurso: Android pedirá ID/token en un diálogo nativo, además del vínculo Crow. No desactives la autenticación global.' : 'El endpoint remoto es configuración manual: guardarlo NO crea ni comprueba un túnel. Configurá Tailscale Serve en tu tailnet para reenviar al backend local que se muestra al iniciar; no uses Funnel ni publiques puertos del router.'}</p>
    {status.running && <><div className="mobile-credentials"><div><strong>LAN · HTTPS fijado por huella</strong><code>{status.url}</code></div>{status.loopbackUrl && <div><strong>Backend remoto · solo loopback</strong><code>{status.loopbackUrl}</code></div>}{status.relayUrl && <div><strong>Relay E2E · {status.relayState === 'connected' ? 'conectado' : status.relayState === 'reconnecting' ? 'reconectando' : 'conectando'}</strong><code>{status.relayUrl}</code></div>}</div>
      <div className="mobile-fingerprint"><strong>Huella SHA-256 del certificado LAN</strong><code>{status.fingerprint}</code></div>
      <p>Android compara esta huella antes de enviar el código. Un cambio de huella exige una nueva vinculación. El endpoint remoto usa certificados HTTPS de confianza, no una excepción global.</p>
      <fieldset disabled={busy}><legend>Proyectos autorizados para esta invitación</legend>{projects.map(project => <label key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={event => setProjectIds(current => event.target.checked ? [...current, project.id] : current.filter(id => id !== project.id))} /> {hosts.find(host => host.id === project.hostId)?.name || project.hostId} · {project.name}</label>)}</fieldset>
      <fieldset disabled={busy}><legend>Permisos del dispositivo · solo lectura por defecto</legend>{(Object.keys(labels) as (keyof MobileCapabilities)[]).map(key => <label key={key}><input type="checkbox" checked={capabilities[key]} onChange={event => setCapabilities(current => ({ ...current, [key]: event.target.checked }))} /> {labels[key]}</label>)}</fieldset>
      <p>Requiere una identidad individual Crow vigente y permisos sobre estos proyectos. Cuotas es una autorización separada: solo lectura de valores ya almacenados en Windows, sin iniciar sesión ni consultar al proveedor.</p>
      <button className="primary-button" disabled={busy || !projectIds.length} onClick={() => void invite()}>{enrollment ? 'Renovar invitación' : 'Generar invitación Android'}</button>
      {enrollment && !expired && <div className="mobile-qr-panel"><strong>Importá este QR desde Crow Android</strong>{qr ? <img src={qr} width="256" height="256" alt="Invitación Android temporal con endpoints y huella TLS" /> : <span role="status">Generando QR…</span>}<small>Vence: {new Date(enrollment.expiresAt).toLocaleTimeString()}. No compartas capturas.</small><details><summary>Importación manual</summary><textarea readOnly aria-label="Invitación Android JSON" value={JSON.stringify(enrollment)} /></details></div>}
      {enrollment && expired && <p role="status">La invitación venció. Generá una nueva; nunca se reutiliza el código.</p>}
      {status.url && status.pairingCode && <details><summary>Navegador LAN anterior</summary><p>Verificá la huella en el navegador antes de aceptar el certificado autofirmado.</p><a href={mobilePairingURL(status.url, status.pairingCode)} target="_blank" rel="noreferrer">Abrir emparejamiento LAN de un solo uso</a></details>}
    </>}
    <h3>Dispositivos vinculados</h3>{!status.devices?.length && <p>Ningún dispositivo vinculado. Confirmá el nombre al completar la vinculación.</p>}{status.devices?.map(device => <div key={device.id} className="mobile-credentials"><div><strong>{device.label}</strong><small>{device.expiresAt === null ? 'Confianza hasta revocación' : `Vínculo antiguo · vence ${new Date(device.expiresAt).toLocaleString()}`} · {device.projectIds.length} proyectos</small><small>{device.capabilities.input ? 'Entrada habilitada' : 'Solo lectura'} · Cuotas {device.capabilities.quotas ? 'compartidas' : 'ocultas'}</small></div><button className="danger-button" disabled={busy} onClick={() => void revoke(device.id, device.label)}>Revocar dispositivo</button></div>)}
    {notice && <p role="status">{notice}</p>}{error && <div ref={errorFocus} tabIndex={-1} className="inline-error" role="alert">{error}</div>}
    <div className="dialog-actions"><span /><button className="secondary-button" disabled={busy} onClick={onClose}>Cerrar</button><button className={status.running ? 'secondary-button' : 'primary-button'} disabled={busy || (!status.running && !address)} onClick={() => void toggle()}>{busy ? 'Aplicando…' : status.running ? 'Pausar acceso' : status.devices?.length ? 'Reanudar acceso' : 'Activar gateway'}</button></div>
  </Modal>
}
