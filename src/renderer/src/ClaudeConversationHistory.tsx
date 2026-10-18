import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, History, RefreshCw, Trash2 } from 'lucide-react'
import type { ClaudeConversation, ConnectionStatus, SessionInfo } from '../../shared/types'
import { useConfirm } from './ConfirmDialog'

interface Props {
  hostId: string
  projectId: string
  status: ConnectionStatus
  revision: string
  onTerminal(session: SessionInfo, name: string): void
}

/** History is independent from tabs and PTYs. Only an explicit click may resume. */
export function ClaudeConversationHistory({ hostId, projectId, status, revision, onTerminal }: Props): React.JSX.Element {
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<ClaudeConversation[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [identityRevision, setIdentityRevision] = useState(0)
  const [pollExpired, setPollExpired] = useState(false)
  const generation = useRef(0), request = useRef(0), mutation = useRef(false), deadline = useRef(0)
  const onTerminalRef = useRef(onTerminal)
  onTerminalRef.current = onTerminal
  const online = status === 'connected'

  useEffect(() => () => { generation.current++; request.current++ }, [])
  useEffect(() => window.crow.onAccessChanged(changedHost => {
    if (changedHost !== hostId) return
    generation.current++; request.current++; deadline.current = 0
    setRows([]); setError(''); setBusy(null); setIdentityRevision(value => value + 1)
  }), [hostId])
  useEffect(() => {
    generation.current++; request.current++; deadline.current = 0
    setLoading(false); setPollExpired(false)
    if (!online) setError('')
  }, [online])

  async function refresh(): Promise<void> {
    if (!online || mutation.current) return
    const scope = generation.current, version = ++request.current
    setLoading(true)
    try {
      const values = await window.crow.claudeConversations(hostId, projectId)
      if (scope !== generation.current || version !== request.current) return
      setRows(values); setError('')
    } catch (reason) {
      if (scope === generation.current && version === request.current) { setRows([]); setError(String(reason)) }
    } finally { if (scope === generation.current && version === request.current) setLoading(false) }
  }
  useEffect(() => { if (open && online) void refresh() }, [open, online, revision, identityRevision])

  const pending = rows.some(row => row.status === 'pending')
  useEffect(() => {
    if (!pending) { deadline.current = 0; setPollExpired(false); return }
    if (!online) return
    if (!deadline.current) deadline.current = Date.now() + 60_000
    if (Date.now() >= deadline.current) { setPollExpired(true); return }
    const timer = setTimeout(() => void refresh(), 2000)
    return () => clearTimeout(timer)
  }, [rows, pending, online])

  async function resume(row: ClaudeConversation): Promise<void> {
    if (!online || mutation.current) return
    mutation.current = true; setBusy(row.id); setError(''); setPollExpired(false)
    request.current++; setLoading(false)
    const scope = generation.current
    try {
      const result = await window.crow.resumeClaudeConversation(hostId, projectId, row.id, crypto.randomUUID())
      if (scope !== generation.current) return
      setRows(current => current.map(value => value.id === row.id ? result.conversation : value))
      if (result.session) onTerminalRef.current(result.session, result.conversation.name)
      // No POST retry: a lost acknowledgement may already have created the PTY.
      if (result.state !== 'pending') void refresh()
    } catch (reason) {
      if (scope === generation.current) setError(`${String(reason)} Si la respuesta se perdió, actualizá el historial antes de volver a intentar.`)
    } finally {
      mutation.current = false
      if (scope === generation.current) setBusy(null)
    }
  }
  async function forget(row: ClaudeConversation): Promise<void> {
    if (!online || mutation.current) return
    mutation.current = true; setBusy(row.id)
    const scope = generation.current
    try {
      if (!await confirm({ message: `¿Olvidar «${row.name || 'Conversación Claude'}» en Crow? Sólo se quita este registro. No se borra el historial nativo de Claude ni se termina ninguna terminal.`, accept: 'Olvidar en Crow', danger: true })) return
      if (scope !== generation.current) return
      await window.crow.forgetClaudeConversation(hostId, projectId, row.id)
      if (scope === generation.current) setRows(current => current.filter(value => value.id !== row.id))
    } catch (reason) { if (scope === generation.current) setError(String(reason)) }
    finally { mutation.current = false; if (scope === generation.current) setBusy(null) }
  }

  return <section className="claude-history" aria-label="Historial de conversaciones Claude">
    <div className="claude-history-heading">
      <button className="claude-history-toggle" aria-expanded={open} aria-controls="claude-history-list" onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<History size={15} /> Conversaciones Claude</button>
      {pending && <span className="claude-history-pending" role="status">Esperando confirmación de Claude…</span>}
      {open && <button className="icon-button" aria-label="Actualizar conversaciones" title="Consultar estado sin reanudar" disabled={!online || loading || !!busy} onClick={() => { deadline.current = 0; setPollExpired(false); void refresh() }}><RefreshCw size={15} /></button>}
    </div>
    {open && <div id="claude-history-list" className="claude-history-list" aria-busy={loading}>
      <p className="claude-history-help">Retomá la misma conversación en una terminal nueva. No hace falta mantenerla abierta. Las conversaciones anteriores a esta función sin un ID guardado no aparecen automáticamente.</p>
      {!online && <p role="status">Conectá el host para consultar o reanudar conversaciones.</p>}
      {error && <p className="claude-history-error" role="alert">{error}</p>}
      {pollExpired && <p role="status">Claude todavía no confirmó el inicio. Actualizá para consultar el estado; no se reenviará la acción.</p>}
      {online && !loading && !error && !rows.length && <p>No hay conversaciones guardadas de este proyecto.</p>}
      {rows.map(row => <div key={row.id} className="claude-history-row">
        <div className="claude-history-description"><strong>{row.name || 'Conversación Claude'}</strong><span>{row.status === 'active' ? 'Terminal activa' : row.status === 'pending' ? 'Esperando confirmación de Claude…' : row.status === 'unavailable' ? row.reason || 'Historial nativo no disponible.' : 'Lista para reanudar'}{row.mode === 'bypass' ? ' · Bypass' : ''} · {new Date(row.updatedAt).toLocaleString()}</span></div>
        <button className={row.status === 'available' ? 'primary-button small-button' : 'secondary-button small-button'} disabled={!online || !!busy || row.status === 'unavailable' || row.status === 'pending'} onClick={() => void resume(row)}>{busy === row.id ? 'Reanudando…' : row.status === 'active' ? 'Ver terminal' : row.status === 'pending' ? 'Reanudando…' : 'Reanudar'}</button>
        <button className="icon-button" title="Olvidar registro en Crow; conserva el historial de Claude" aria-label={`Olvidar conversación ${row.name || 'Claude'}`} disabled={!online || !!busy || row.status === 'active' || row.status === 'pending'} onClick={() => void forget(row)}><Trash2 size={14} /></button>
      </div>)}
    </div>}
  </section>
}
