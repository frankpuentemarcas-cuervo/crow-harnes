import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ConnectionStatus, SessionInfo } from '../../shared/types'
import { CacheBadge, cacheCauseLabels } from './CacheBadge'

export function CacheDetailsDialog({ session, status, now, onClose }: { session: SessionInfo; status: ConnectionStatus; now: number; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [])
  const cache = session.promptCache
  const count = (value: number | undefined): string => value === undefined ? '—' : value.toLocaleString('es')
  return <dialog ref={dialog} className="dialog-card cache-dialog" onCancel={onClose} aria-labelledby="cache-detail-title">
    <div className="dialog-heading"><h2 id="cache-detail-title">Caché Claude · {session.id.slice(0, 8)}</h2><button className="icon-button" aria-label="Cerrar detalle de caché" onClick={onClose}><X size={18} /></button></div>
    <CacheBadge session={session} status={status} now={now} />
    <p>Estadísticas reportadas por Claude para la conversación principal. No incluyen subagentes ni garantizan un acierto en la siguiente solicitud.</p>
    <dl className="cache-details">
      <dt>Duración reportada</dt><dd>{cache?.ttlSeconds === 3600 ? '1 hora' : cache?.ttlSeconds === 300 ? '5 minutos' : 'Sin datos'}</dd>
      <dt>Reutilización de la sesión</dt><dd>{cache?.hitRatio === undefined ? '—' : `${Math.round(cache.hitRatio * 100)}%`}</dd>
      <dt>Leídos de caché · última solicitud</dt><dd>{count(cache?.readTokens)} tokens</dd>
      <dt>Escritos en caché · última solicitud</dt><dd>{count(cache?.writtenTokens)} tokens</dd>
      <dt>Nuevos · última solicitud</dt><dd>{count(cache?.freshTokens)} tokens</dd>
      <dt>Solicitudes / fallos de caché</dt><dd>{count(cache?.requests)} / {count(cache?.misses)}</dd>
    </dl>
    {!!cache?.lastMissCauses?.length && <p>Posibles causas del último fallo: {cache.lastMissCauses.map(cause => cacheCauseLabels[cause]).filter(Boolean).join(', ')}.</p>}
    {cache?.reportedAt && <small>Último reporte: {new Date(cache.reportedAt).toLocaleString()}</small>}
    <p className="cache-note">Sin datos: actualizá crowd en Linux y abrí una terminal nueva con hooks activos. Claude Code 2.1.251+ entrega estas métricas; configuraciones administradas pueden impedir el colector. Vencer la caché no elimina tu conversación.</p>
  </dialog>
}
