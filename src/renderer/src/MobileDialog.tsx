import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Host, MobileStatus, Project } from '../../shared/types'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'

/** One explicit action provisions the Windows gateway and every selected Linux host. */
export function MobileDialog({ projects, hosts, onClose }: { projects: Project[]; hosts: Host[]; onClose(): void }): React.JSX.Element {
  const [status, setStatus] = useState<MobileStatus>({ running: false })
  const [selected, setSelected] = useState<string[]>(projects.map(project => project.id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [qr, setQR] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [hostCount, setHostCount] = useState(0)
  const [skippedHosts, setSkippedHosts] = useState<Array<{ name: string; reason: string }>>([])
  const [now, setNow] = useState(Date.now())
  const focus = useRef<HTMLDivElement>(null)
  const confirm = useConfirm()

  useEffect(() => {
    let live = true
    void window.crow.mobileStatus().then(value => { if (live) setStatus(value) }).catch(reason => { if (live) setError(String(reason)) })
    const timer = setInterval(() => { setNow(Date.now()); void window.crow.mobileStatus().then(value => { if (live) setStatus(value) }).catch(() => undefined) }, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  useEffect(() => { if (error) focus.current?.focus() }, [error])

  async function generate(): Promise<void> {
    if (busy) return
    setBusy(true); setError(''); setQR(''); setSkippedHosts([])
    try {
      const result = await window.crow.mobileInvite({ projectIds: selected, capabilities: { input: true, create: true, close: false, quotas: false } })
      setQR(result.qrDataUrl); setExpiresAt(result.enrollment.expiresAt); setHostCount(result.hostCount || 0); setSkippedHosts(result.skippedHosts || [])
      setStatus(await window.crow.mobileStatus())
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  async function revoke(id: string, label: string): Promise<void> {
    if (!await confirm({ message: `¿Revocar «${label}»? Este equipo tendrá que vincularse otra vez.`, accept: 'Revocar', danger: true })) return
    setBusy(true); setError('')
    try { setStatus(await window.crow.mobileRevoke(id)) } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }

  const validQR = !!qr && Date.parse(expiresAt) > now
  return <Modal className="mobile-dialog" titleId="mobile-title" busy={busy} initialFocus="[data-close]" onClose={onClose}>
    <div className="dialog-heading"><h2 id="mobile-title">Acceso móvil</h2><button data-close className="icon-button" aria-label="Cerrar" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <p>Un solo QR vincula Android con Crow Windows y las terminales de tus hosts Linux. No necesitás ingresar dominio, puerto ni credenciales Pangolin.</p>
    <p className="mobile-security-note">El QR incluye solo los hosts disponibles y autorizados al generarlo. Los demás se omiten; podés vincularlos más adelante con otro QR. Después, las terminales vinculadas siguen disponibles aunque cierres Windows.</p>
    <fieldset disabled={busy}><legend>Proyectos incluidos · {selected.length} de {projects.length}</legend>
      <div className="mobile-project-actions"><button type="button" onClick={() => setSelected(projects.map(project => project.id))}>Seleccionar todos</button><button type="button" onClick={() => setSelected([])}>Quitar selección</button></div>
      {projects.map(project => <label key={project.id}><input type="checkbox" checked={selected.includes(project.id)} onChange={event => setSelected(current => event.target.checked ? [...current, project.id] : current.filter(id => id !== project.id))} /> {hosts.find(host => host.id === project.hostId)?.name || project.hostId} · {project.name}</label>)}
    </fieldset>
    <button className="primary-button" disabled={busy || !selected.length} onClick={() => void generate()}>{busy ? 'Preparando hosts…' : validQR ? 'Renovar QR' : 'Generar QR para Android'}</button>
    {validQR && <div className="mobile-qr-panel"><strong>Escaneá una sola vez en Crow Android</strong><img src={qr} width="384" height="384" alt={`QR temporal para Crow Windows y ${hostCount} hosts`} /><small>{hostCount} hosts Linux · vence {new Date(expiresAt).toLocaleTimeString()}. No compartas esta imagen.</small></div>}
    {validQR && skippedHosts.length > 0 && <p role="status" className="mobile-security-note">No incluidos en este QR: {skippedHosts.map(host => `${host.name} (${host.reason})`).join(', ')}.</p>}
    {qr && !validQR && <p role="status">El QR venció. Generá uno nuevo; los vínculos ya creados permanecen.</p>}
    {status.running && <p role="status">Crow Windows {status.relayState === 'connected' ? 'conectado al relay' : 'reconectando al relay'}. Los hosts Linux mantienen conexiones independientes.</p>}
    {!!status.devices?.length && <section><h3>Dispositivos vinculados a Windows</h3>{status.devices.map(device => <div key={device.id} className="mobile-credentials"><div><strong>{device.label}</strong><small>{device.expiresAt ? `Vence ${new Date(device.expiresAt).toLocaleString()}` : 'Vínculo hasta revocación'}</small></div><button className="danger-button" disabled={busy} onClick={() => void revoke(device.id, device.label)}>Revocar</button></div>)}</section>}
    {error && <div ref={focus} tabIndex={-1} className="inline-error" role="alert">{error}</div>}
    <div className="dialog-actions"><span /><button className="secondary-button" disabled={busy} onClick={onClose}>Cerrar</button></div>
  </Modal>
}
