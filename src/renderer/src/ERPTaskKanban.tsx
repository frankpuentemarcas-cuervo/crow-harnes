import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ERPProjectCandidate, ERPTaskCard, ERPTaskPreview, ERPTaskSnapshot, ERPTaskStage } from '../../shared/erp-task'
import { Modal } from './Modal'
import './erp-access.css'

const stages: { id: ERPTaskStage; label: string }[] = [{ id: 'review', label: 'Por revisar' }, { id: 'ready', label: 'Lista' }, { id: 'running', label: 'En agente' }, { id: 'human-review', label: 'Revisión humana' }, { id: 'done', label: 'Hecha (local)' }]
export function ERPTaskKanban({ onClose, onTerminal }: { onClose(): void; onTerminal(projectId: string, sessionId: string): void }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ERPTaskSnapshot | null>(null)
  const [projects, setProjects] = useState<ERPProjectCandidate[]>([])
  const [url, setURL] = useState(''), [key, setKey] = useState(''), [secret, setSecret] = useState('')
  const [consent, setConsent] = useState(false), [agent, setAgent] = useState<'claude' | 'codex'>('claude')
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<ERPTaskPreview | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [visibleCounts, setVisibleCounts] = useState<Partial<Record<ERPTaskStage, number>>>({})
  const alive = useRef(true), lock = useRef(false)
  async function run(action: () => Promise<void>): Promise<void> {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setStatus('')
    try { await action() }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'No se pudo completar la operación.') }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function update(next: ERPTaskSnapshot): void { if (alive.current) setSnapshot(next) }
  useEffect(() => {
    alive.current = true; let canceled = false
    void Promise.resolve().then(() => { if (!canceled) void run(async () => { const [next, permitted] = await Promise.all([window.crow.erpSnapshot(), window.crow.erpProjects()]); if (!alive.current) return; update(next); setProjects(permitted); setURL(next.connection.url); setConsent(next.connection.allowAIClassification) }) })
    const off = window.crow.onAccessChanged(() => { if (alive.current) { setPreview(null); setProjects([]); void run(async () => { const permitted = await window.crow.erpProjects(); if (alive.current) setProjects(permitted); update(await window.crow.erpSnapshot()) }) } })
    return () => { canceled = true; alive.current = false; off() }
  }, [])
  const projectFor = (task: ERPTaskCard): string => selected[task.key] || task.projectId || ''
  const columns = stages.map(stage => ({ ...stage, tasks: snapshot?.tasks.filter(task => task.stage === stage.id) ?? [] }))
  return <Modal titleId="erp-title" className="erp-access-dialog" busy={busy} onClose={onClose}>
    <div className="dialog-heading"><h2 id="erp-title">ERPNext · Kanban de Tasks</h2><button className="icon-button" disabled={busy} aria-label="Cerrar ERPNext" onClick={onClose}><X size={18} /></button></div>
    <p>La IA busca y relaciona tareas exclusivamente del DocType <strong>Task</strong>, según los permisos de tu conexión ERPNext. Crow no modifica el ERP.</p>
    <form onSubmit={event => { event.preventDefault(); const input = { url, apiKey: key || undefined, apiSecret: secret || undefined, allowAIClassification: consent }; setKey(''); setSecret(''); setPreview(null); void run(async () => update(await window.crow.erpSaveConnection(input))) }}>
      <label>URL de ERPNext (HTTPS)<input type="url" required value={url} placeholder="https://erp.ejemplo.com" onChange={event => setURL(event.target.value)} /></label>
      <div className="erp-actions"><label>API key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={snapshot?.connection.configured ? 'Guardada · vacío para conservar' : ''} /></label><label>API secret<input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} placeholder={snapshot?.connection.configured ? 'Guardado · vacío para conservar' : ''} /></label></div>
      <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> Autorizo enviar texto mínimo de Tasks y nombres de proyectos a Free LLM API para clasificarlos. No autoriza ejecución.</label>
      <button className="secondary-button" disabled={busy}>Guardar conexión y consentimiento</button>
    </form>
    <div className="erp-actions"><button className="secondary-button" disabled={busy || !snapshot?.connection.configured} onClick={() => { setPreview(null); void run(async () => { update(await window.crow.erpTestConnection()); if (alive.current) setStatus('Conexión verificada. Para cargar las tareas, usá Consultar DocType Task.') }) }}>Probar conexión</button><button className="secondary-button" disabled={busy || !snapshot?.connection.configured} onClick={() => { setPreview(null); void run(async () => { const permitted = await window.crow.erpProjects(); if (alive.current) setProjects(permitted); update(await window.crow.erpSync()); if (alive.current) setStatus('Consulta completa. Las Tasks obsoletas siguen bloqueadas para ejecución.') }) }}>Consultar DocType Task</button><label>Agente para nueva terminal<select value={agent} onChange={event => { setAgent(event.target.value as 'claude' | 'codex'); setPreview(null) }}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label></div>
    <p>Probar conexión verifica tus credenciales y acceso a Task sin descargar el catálogo. Consultar DocType Task carga las páginas completas.</p>
    <p role="status">{busy ? 'Procesando…' : `Identidad ERP: ${snapshot?.connection.identity || 'sin verificar'} · ${snapshot?.tasks.length ?? 0} Tasks`}</p>
    {!busy && status && <p role="status">{status}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}{snapshot?.connection.error && <p role="alert">{snapshot.connection.error}</p>}
    <p>Conectá los hosts para habilitar sus proyectos. El estado del ERP y las columnas locales son independientes; terminar un turno del agente NO marca la tarea como hecha.</p>
    {preview && <section aria-label="Autorización de tarea"><h3>Revisá antes de autorizar</h3><p>Proyecto: {projects.find(project => project.id === preview.projectId)?.name} · host {preview.hostId} · {preview.agent} · permisos normales. Vence {new Date(preview.expiresAt).toLocaleTimeString()}.</p><pre className="erp-prompt">{preview.initialPrompt}</pre><div className="erp-actions"><button className="primary-button" disabled={busy} onClick={() => { const id = preview.previewId; setPreview(null); void run(async () => update(await window.crow.erpApprove(id))) }}>Autorizar nueva terminal y enviar esta Task</button><button className="secondary-button" disabled={busy} onClick={() => setPreview(null)}>Cancelar</button></div></section>}
    <div className="erp-kanban">{columns.map(stage => <section key={stage.id} className="erp-column" aria-label={stage.label}><h3>{stage.label} · {stage.tasks.length}</h3>{stage.tasks.slice(0, visibleCounts[stage.id] ?? 50).map(task => <article key={task.key} className="erp-task"><h4>{task.subject || task.name}</h4><small>{task.name} · ERP: {task.erpStatus} · {task.erpProject || 'sin proyecto ERP'}</small><details><summary>Detalle de la Task</summary><p>{task.description}</p></details>{task.stale && <small>Datos anteriores: consultá de nuevo antes de ejecutar.</small>}{task.reason && <small>{task.reason}</small>}{task.error && <small role="alert">{task.error}</small>}{task.dispatchStatus && <small>Entrega: {task.dispatchStatus === 'delivered' ? 'confirmada' : task.dispatchStatus === 'uncertain' ? 'incierta · verificá la terminal; no reenviar' : 'pendiente'}</small>}
      {!task.jobId && <><label>Proyecto Crow<select disabled={busy || task.stale} value={projectFor(task)} onChange={event => { setSelected(current => ({ ...current, [task.key]: event.target.value })); setPreview(null) }}><option value="">Elegir…</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.hostId}</option>)}</select></label><button className="secondary-button" disabled={busy || !projectFor(task) || task.stale} onClick={() => void run(async () => update(await window.crow.erpAssign(task.key, projectFor(task))))}>Asociar esta Task</button>{task.erpProject && <button className="secondary-button" disabled={busy || !projectFor(task) || task.stale} onClick={() => void run(async () => update(await window.crow.erpLinkProject(task.erpProject, projectFor(task))))}>Vincular proyecto ERP completo</button>}<button className="secondary-button" disabled={busy || task.stale || !snapshot?.connection.allowAIClassification || !projects.length} onClick={() => void run(async () => update(await window.crow.erpClassify(task.key)))}>Proponer proyecto con IA</button><button className="primary-button" disabled={busy || task.stale || !projectFor(task)} onClick={() => void run(async () => { const project = projects.find(item => item.id === projectFor(task)); if (!project) throw new Error('Elegí un proyecto permitido.'); const next = await window.crow.erpPreview({ taskKey: task.key, projectId: project.id, hostId: project.hostId, agent }); if (alive.current) setPreview(next) })}>Revisar autorización</button></>}
      {task.sessionId && task.projectId && <button className="secondary-button" onClick={() => onTerminal(task.projectId!, task.sessionId!)}>Ver terminal creada</button>}
      <label>Mover estado local<select disabled={busy || task.dispatchStatus === 'pending' || task.dispatchStatus === 'uncertain'} value={task.stage} onChange={event => { const next = event.target.value as ERPTaskStage; setPreview(null); void run(async () => update(await window.crow.erpMove(task.key, next))) }}>{stages.filter(item => item.id === task.stage || item.id === 'review' || item.id === 'human-review' || (item.id === 'done' && task.stage === 'human-review')).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    </article>)}{stage.tasks.length > (visibleCounts[stage.id] ?? 50) && <button className="secondary-button" disabled={busy} onClick={() => setVisibleCounts(current => ({ ...current, [stage.id]: (current[stage.id] ?? 50) + 50 }))} aria-label={`Mostrar más Tasks en ${stage.label}`}>Mostrar más · {stage.tasks.length - (visibleCounts[stage.id] ?? 50)} restantes</button>}</section>)}</div>
  </Modal>
}
