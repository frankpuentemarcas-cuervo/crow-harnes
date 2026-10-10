import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { X } from 'lucide-react'
import type { Host, MobileStatus, Project } from '../../shared/types'
import type { MobileCapabilities } from '../../shared/mobile-companion'
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
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [capabilities, setCapabilities] = useState(defaults)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [qr, setQR] = useState('')
  const [now, setNow] = useState(Date.now())
  const working = useRef(false)
  const confirm = useConfirm()
  useEffect(() => {
    let live = true
    void Promise.all([window.crow.mobileAddresses(), window.crow.mobileStatus()]).then(([items, current]) => {
      if (!live) return
      setAddresses(items); setAddress(items[0] || ''); setStatus(current)
      setPublicOrigin(current.enrollment?.endpoints.find(item => item.kind === 'remote-public')?.url || '')
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
    if (!enrollment || expired) return
    let live = true
    void QRCode.toDataURL(JSON.stringify(enrollment), { width: 256, margin: 2, errorCorrectionLevel: 'M' }).then(value => { if (live) setQR(value) }).catch(reason => { if (live) setError(`No se pudo generar el QR: ${String(reason)}`) })
    return () => { live = false }
  }, [enrollment?.invitationCode, expired])

  async function run(operation: () => Promise<void>): Promise<void> {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (reason) { setError(String(reason)) }
    finally { working.current = false; setBusy(false) }
  }
  async function toggle(): Promise<void> {
    if (status.running && !await confirm({ message: 'Detener el gateway revoca todos los dispositivos. Las sesiones remotas se conservan.', accept: 'Detener acceso', danger: true })) return
    await run(async () => {
      setStatus(status.running ? await window.crow.mobileStop() : await window.crow.mobileStart({ address, ...(publicOrigin.trim() ? { publicOrigin: publicOrigin.trim() } : {}) }))
      setNotice(status.running ? 'Acceso detenido. Para volver, vinculá el teléfono otra vez.' : 'Gateway iniciado. Elegí proyectos y generá una invitación.')
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
    {!status.running && <><label>IPv4 privada de este equipo<select disabled={busy} value={address} onChange={event => setAddress(event.target.value)}>{addresses.map(item => <option key={item}>{item}</option>)}</select></label>
      {!addresses.length && <p>No se detectó una IPv4 privada. Conectá Windows a una red local confiable.</p>}
      <label>Endpoint HTTPS remoto de Tailscale Serve (opcional)<input disabled={busy} type="url" placeholder="https://equipo.tailnet.ts.net" value={publicOrigin} onChange={event => setPublicOrigin(event.target.value)} /></label></>}
    <p className="mobile-security-note">El endpoint remoto es configuración manual: guardarlo NO crea ni comprueba un túnel. Configurá Tailscale Serve en tu tailnet para reenviar al backend local que se muestra al iniciar; no uses Funnel ni publiques puertos del router.</p>
    {status.running && <><div className="mobile-credentials"><div><strong>LAN · HTTPS fijado por huella</strong><code>{status.url}</code></div>{status.loopbackUrl && <div><strong>Backend de Serve · solo loopback</strong><code>{status.loopbackUrl}</code></div>}</div>
      <div className="mobile-fingerprint"><strong>Huella SHA-256 del certificado LAN</strong><code>{status.fingerprint}</code></div>
      <p>Android compara esta huella antes de enviar el código. Un cambio de huella exige una nueva vinculación. El endpoint remoto usa certificados HTTPS de confianza, no una excepción global.</p>
      <fieldset disabled={busy}><legend>Proyectos autorizados para esta invitación</legend>{projects.map(project => <label key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={event => setProjectIds(current => event.target.checked ? [...current, project.id] : current.filter(id => id !== project.id))} /> {hosts.find(host => host.id === project.hostId)?.name || project.hostId} · {project.name}</label>)}</fieldset>
      <fieldset disabled={busy}><legend>Permisos del dispositivo · solo lectura por defecto</legend>{(Object.keys(labels) as (keyof MobileCapabilities)[]).map(key => <label key={key}><input type="checkbox" checked={capabilities[key]} onChange={event => setCapabilities(current => ({ ...current, [key]: event.target.checked }))} /> {labels[key]}</label>)}</fieldset>
      <p>Requiere una identidad individual Crow vigente y permisos sobre estos proyectos. Cuotas es una autorización separada: solo lectura de valores ya almacenados en Windows, sin iniciar sesión ni consultar al proveedor.</p>
      <button className="primary-button" disabled={busy || !projectIds.length} onClick={() => void invite()}>{enrollment ? 'Renovar invitación' : 'Generar invitación Android'}</button>
      {enrollment && !expired && <div className="mobile-qr-panel"><strong>Importá este QR desde Crow Android</strong>{qr ? <img src={qr} width="256" height="256" alt="Invitación Android temporal con endpoints y huella TLS" /> : <span role="status">Generando QR…</span>}<small>Vence: {new Date(enrollment.expiresAt).toLocaleTimeString()}. No compartas capturas.</small><details><summary>Importación manual</summary><textarea readOnly aria-label="Invitación Android JSON" value={JSON.stringify(enrollment)} /></details></div>}
      {enrollment && expired && <p role="status">La invitación venció. Generá una nueva; nunca se reutiliza el código.</p>}
      <h3>Dispositivos vinculados</h3>{!status.devices?.length && <p>Ningún dispositivo vinculado. Confirmá el nombre al completar la vinculación.</p>}{status.devices?.map(device => <div key={device.id} className="mobile-credentials"><div><strong>{device.label}</strong><small>Vence {new Date(device.expiresAt).toLocaleString()} · {device.projectIds.length} proyectos</small><small>{device.capabilities.input ? 'Entrada habilitada' : 'Solo lectura'} · Cuotas {device.capabilities.quotas ? 'compartidas' : 'ocultas'}</small></div><button className="danger-button" disabled={busy} onClick={() => void revoke(device.id, device.label)}>Revocar</button></div>)}
      {status.url && status.pairingCode && <details><summary>Navegador LAN anterior</summary><p>Verificá la huella en el navegador antes de aceptar el certificado autofirmado.</p><a href={mobilePairingURL(status.url, status.pairingCode)} target="_blank" rel="noreferrer">Abrir emparejamiento LAN de un solo uso</a></details>}
    </>}
    {notice && <p role="status">{notice}</p>}{error && <div className="inline-error" role="alert">{error}</div>}
    <div className="dialog-actions"><span /><button className="secondary-button" disabled={busy} onClick={onClose}>Cerrar</button><button className={status.running ? 'danger-button' : 'primary-button'} disabled={busy || (!status.running && !address)} onClick={() => void toggle()}>{busy ? 'Aplicando…' : status.running ? 'Detener acceso' : 'Activar gateway'}</button></div>
  </Modal>
}
