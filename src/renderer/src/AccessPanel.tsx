import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AccessIdentity } from '../../shared/access'
import type { CrowAccessPrincipal, CrowAccessStatus, Host, SessionInfo } from '../../shared/types'
import { Modal } from './Modal'
import './erp-access.css'

export function AccessPanel({ host, sessions, onClose }: { host: Host; sessions: SessionInfo[]; onClose(): void }): React.JSX.Element {
  const [status, setStatus] = useState<CrowAccessStatus | null>(null)
  const [identity, setIdentity] = useState<AccessIdentity | null>(null)
  const [users, setUsers] = useState<CrowAccessPrincipal[]>([])
  const [label, setLabel] = useState('')
  const [credential, setCredential] = useState('')
  const [issued, setIssued] = useState('')
  const [roots, setRoots] = useState('')
  const [operateOthers, setOperateOthers] = useState(false)
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true), lock = useRef(false)
  async function refresh(): Promise<void> {
    const next = await window.crow.accessStatus(host.id)
    if (!alive.current) return
    setStatus(next)
    try {
      const who = await window.crow.accessIdentity(host.id)
      if (!alive.current) return
      setIdentity(who)
      if (who.role === 'admin') { const list = await window.crow.accessUsers(host.id); if (alive.current) setUsers(list) }
      else setUsers([])
    } catch { if (alive.current) { setIdentity(null); setUsers([]) } }
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await action(); await refresh() }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'No se pudo actualizar el acceso.') }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => { alive.current = true; let canceled = false; void Promise.resolve().then(() => { if (!canceled) void run(refresh) }); return () => { canceled = true; alive.current = false } }, [])
  const admin = identity?.role === 'admin'
  return <Modal titleId="access-title" className="erp-access-dialog" onClose={onClose} busy={busy}>
    <div className="dialog-heading"><h2 id="access-title">Acceso · {host.name}</h2><button className="icon-button" disabled={busy} aria-label="Cerrar acceso" onClick={onClose}><X size={18} /></button></div>
    <p>Identidades de Crow independientes de SSH. Compartir usuario Linux NO protege frente a alguien con acceso al sistema.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <p role="status">{busy ? 'Actualizando…' : identity ? `${identity.label} · ${identity.role === 'admin' ? 'Administrador: ve todas las terminales' : identity.role === 'member' ? 'Miembro: sólo sus terminales' : 'Modo compartido anterior'}` : 'Ingresá tu credencial individual.'}</p>
    {status && !status.enabled && <form onSubmit={event => { event.preventDefault(); void run(async () => { await window.crow.accessEnable(host.id, label.trim()); setLabel('') }) }}><label>Nombre del primer administrador<input value={label} required maxLength={100} onChange={event => setLabel(event.target.value)} /></label><p>Las terminales anteriores quedarán sin dueño, visibles sólo al administrador hasta asignarlas.</p><button className="primary-button" disabled={busy || !label.trim()}>Activar acceso individual</button></form>}
    <form onSubmit={event => { event.preventDefault(); const token = credential.trim(); setCredential(''); setIssued(''); void run(() => window.crow.accessImportCredential(host.id, token)) }}><label>Credencial individual<input type="password" autoComplete="off" value={credential} onChange={event => setCredential(event.target.value)} required /></label><button className="secondary-button" disabled={busy || !credential.trim()}>Usar esta identidad</button></form>
    {admin && <>
      <form onSubmit={event => { event.preventDefault(); setIssued(''); void run(async () => { const result = await window.crow.accessCreateUser(host.id, { label: label.trim(), role, operateOthers: role === 'admin' && operateOthers, allowedRoots: roots.split('\n').map(root => root.trim()).filter(Boolean) }); if (alive.current) { setIssued(result.credential); setLabel('') } }) }}>
        <h3>Registrar usuario</h3><label>Nombre<input required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} /></label>
        <label>Rol<select value={role} onChange={event => setRole(event.target.value as 'admin' | 'member')}><option value="member">Miembro · terminales propias</option><option value="admin">Administrador · ve todas</option></select></label>
        <label>Carpetas de proyectos permitidas (una ruta absoluta por línea)<textarea value={roots} onChange={event => setRoots(event.target.value)} placeholder="/srv/proyecto" required /></label>
        {role === 'admin' && <label><input type="checkbox" checked={operateOthers} onChange={event => setOperateOthers(event.target.checked)} /> Permiso especial para operar terminales ajenas</label>}
        <button className="secondary-button" disabled={busy || !label.trim() || !roots.trim()}>Crear miembro</button>
      </form>
      {issued && <section><p>Credencial mostrada una sola vez. Compartila por un canal seguro, no por una terminal.</p><label>Credencial creada<input readOnly type="password" value={issued} /></label><button className="secondary-button" onClick={() => void run(() => window.crow.clipboardWriteText(issued))}>Copiar credencial</button><button className="secondary-button" onClick={() => setIssued('')}>Ocultar y descartar</button></section>}
      <h3>Usuarios</h3>{users.map(user => <div className="access-user-row" key={user.id}><span>{user.label} · {user.role}{user.revoked ? ' · revocado' : ''}</span><button className="secondary-button" disabled={busy || user.revoked || ('id' in identity && user.id === identity.id)} onClick={() => void run(() => window.crow.accessRevokeUser(host.id, user.id))}>Revocar</button></div>)}
      <h3>Asignar terminales anteriores</h3>{sessions.filter(session => !session.ownerId).map(session => <label key={session.id}>{session.agent} · {session.id.slice(0, 8)}<select defaultValue="" disabled={busy} onChange={event => { const owner = event.target.value; if (owner) void run(() => window.crow.accessAssignSession(host.id, session.id, owner)) }}><option value="">Elegir propietario…</option>{users.filter(user => !user.revoked).map(user => <option key={user.id} value={user.id}>{user.label}</option>)}</select></label>)}
    </>}
  </Modal>
}
