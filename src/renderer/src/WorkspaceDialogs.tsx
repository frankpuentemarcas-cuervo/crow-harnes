import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Host, Project, ProjectInput } from '../../shared/types'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'

function useAction(): { busy: boolean; error: string; run(action: () => Promise<void>): Promise<void> } {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return { busy, error, async run(action) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; setBusy(false) }
  } }
}

export function HostDialog({ host, hostConnected, hooksEnabled, onToggleHooks, onClose, onSave, onDelete, onExportDiagnostics }: { host?: Host; hostConnected: boolean; hooksEnabled?: boolean; onToggleHooks?: (enabled: boolean) => Promise<void>; onClose: () => void; onSave: (host: Omit<Host, 'id'> & { id?: string }) => Promise<void>; onDelete?: () => Promise<void>; onExportDiagnostics?: () => Promise<void> }): React.JSX.Element {
  const confirm = useConfirm(), action = useAction()
  const [name, setName] = useState(host?.name || ''), [target, setTarget] = useState(host?.target || '')
  const [port, setPort] = useState(host?.port || 22), [remotePort, setRemotePort] = useState(host?.remotePort || 47321)
  const [identity, setIdentity] = useState(host?.identity || '')
  return <Modal titleId="host-title" busy={action.busy} initialFocus="input" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void action.run(() => onSave({ id: host?.id, name, target, port, remotePort, identity: identity || undefined })) }}>
      <div className="dialog-heading"><h2 id="host-title">{host ? 'Editar host' : 'Agregar host'}</h2><button type="button" className="icon-button" aria-label="Cerrar" disabled={action.busy} onClick={onClose}><X size={18} /></button></div>
      <p>Conexión SSH hacia el servicio Crow instalado en el servidor.</p>
      <fieldset disabled={action.busy}>
        <label>Nombre<input required value={name} onChange={event => setName(event.target.value)} placeholder="Servidor principal" /></label>
        <label>Destino SSH<input required value={target} onChange={event => setTarget(event.target.value)} placeholder="usuario@servidor o alias" /></label>
        <div className="dialog-columns"><label>Puerto SSH<input required type="number" min="1" max="65535" value={port} onChange={event => setPort(Number(event.target.value))} /></label><label>Puerto del servicio<input required type="number" min="1" max="65535" value={remotePort} onChange={event => setRemotePort(Number(event.target.value))} /></label></div>
        <label>Archivo de clave SSH (opcional)<input value={identity} onChange={event => setIdentity(event.target.value)} placeholder="C:\Users\...\.ssh\id_ed25519" /></label>
        {host && <label className="hook-toggle"><input type="checkbox" checked={hooksEnabled ?? false} disabled={!hostConnected || hooksEnabled === undefined} onChange={event => { const enabled = event.target.checked; void action.run(async () => { await onToggleHooks?.(enabled) }) }} /><span>Hooks de estado administrados por Crow<small>Estados del agente y métricas de caché Claude. El colector se agrega a nuevas terminales.</small></span></label>}
      </fieldset>
      {host && onExportDiagnostics && <div className="dialog-actions"><button type="button" className="secondary-button" disabled={action.busy} onClick={() => void action.run(onExportDiagnostics)}>Exportar diagnóstico de conexión</button></div>}
      {action.error && <div className="inline-error" role="alert">{action.error}</div>}
      <div className="dialog-actions">{onDelete && <button type="button" disabled={action.busy} className="danger-button" onClick={() => void action.run(async () => {
        if (await confirm({ message: '¿Quitar este host y sus proyectos de la app? Se cerrarán sus vistas locales y se perderán los borradores sin guardar. Las sesiones remotas no se cierran.', accept: 'Quitar host', danger: true })) await onDelete()
      })}>Quitar host</button>}<span /><button type="button" className="secondary-button" disabled={action.busy} onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={action.busy}>{action.busy ? 'Aplicando…' : 'Guardar'}</button></div>
    </form>
  </Modal>
}

export function ProjectDialog({ project, hosts, defaultHostId, onClose, onSave }: { project?: Project; hosts: Host[]; defaultHostId: string; onClose: () => void; onSave: (project: ProjectInput) => Promise<void> }): React.JSX.Element {
  const action = useAction()
  const [name, setName] = useState(project?.name || ''), [hostId, setHostId] = useState(project?.hostId || defaultHostId), [root, setRoot] = useState(project?.root || '')
  const [summary, setSummary] = useState(project?.summary || ''), [tags, setTags] = useState(project?.tags?.join(', ') || ''), [gitlabUrl, setGitlabUrl] = useState(project?.gitlabUrl || ''), [allowGitLabRead, setAllowGitLabRead] = useState(project?.allowGitLabRead || false), [gitlabToken, setGitlabToken] = useState('')
  return <Modal titleId="project-title" busy={action.busy} initialFocus="input" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void action.run(() => onSave({ id: project?.id, name, hostId, root, summary, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), gitlabUrl, allowGitLabRead, gitlabToken: gitlabToken || undefined })) }}>
      <div className="dialog-heading"><h2 id="project-title">{project ? 'Editar proyecto' : 'Agregar proyecto'}</h2><button type="button" className="icon-button" aria-label="Cerrar" disabled={action.busy} onClick={onClose}><X size={18} /></button></div>
      <p>El catálogo y el contexto se guardan en esta PC. Vincular una instancia GitLab propia no habilita la lectura automáticamente.</p>
      <fieldset disabled={action.busy}><label>Nombre<input required value={name} onChange={event => setName(event.target.value)} placeholder="Mi aplicación" /></label><label>Host<select required value={hostId} onChange={event => setHostId(event.target.value)}>{hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label><label>Carpeta absoluta en Linux<input required value={root} onChange={event => setRoot(event.target.value)} placeholder="/home/usuario/proyectos/mi-app" /></label><label>Resumen del proyecto<textarea maxLength={1000} value={summary} onChange={event => setSummary(event.target.value)} placeholder="Qué hace, para quién y cuáles son sus componentes principales" /></label><label>Etiquetas separadas por coma<input value={tags} onChange={event => setTags(event.target.value)} placeholder="erp, rrhh, frappe" /></label><label>Repositorio GitLab (HTTPS)<input type="url" value={gitlabUrl} onChange={event => setGitlabUrl(event.target.value)} placeholder="https://gitlab.miempresa.com/grupo/proyecto" /></label>
        {gitlabUrl && <><label className="hook-toggle"><input type="checkbox" checked={allowGitLabRead} onChange={event => setAllowGitLabRead(event.target.checked)} /><span>Permitir lectura del repositorio<small>Sólo explora y lee archivos que seleccionás. Esto no autoriza enviarlos a Free LLM.</small></span></label>{allowGitLabRead && <label>Token de GitLab de solo lectura<input type="password" autoComplete="off" value={gitlabToken} onChange={event => setGitlabToken(event.target.value)} placeholder="Guardado cifrado · vacío para conservar" /><small>Usá el scope mínimo read_repository o read_api. Se cifra en Windows; no va a state.json ni al host remoto. Se acepta tu dominio HTTPS.</small></label>}</>}</fieldset>
      {action.error && <div className="inline-error" role="alert">{action.error}</div>}
      <div className="dialog-actions"><span /><button type="button" className="secondary-button" disabled={action.busy} onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={action.busy}>{action.busy ? 'Guardando…' : 'Guardar proyecto'}</button></div>
    </form>
  </Modal>
}
