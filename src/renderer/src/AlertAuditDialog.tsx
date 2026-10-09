import { useEffect, useRef, useState } from 'react'
import type { Host } from '../../shared/types'
import { auditReasons, type AlertAuditRecord, type AlertAuditStatus, type AlertAuditSummary, type NoticeSoundOutcome } from '../../shared/alert-diagnostics'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'

const soundLabels: Record<NoticeSoundOutcome, string> = { eligible: 'Alerta habilitada para sonido', pending: 'Esperando clasificación', informational: 'Silencio: informativa', 'already-read': 'Silencio: ya revisada', duplicate: 'Silencio: evento repetido', restored: 'Silencio: historial restaurado', stale: 'Silencio: evento antiguo', scheduled: 'Reproducción programada', 'playback-ended': 'Reproducción finalizada', 'playback-error': 'Falló la reproducción' }

export function AlertAuditDialog({ hosts, sessionNames, onClose }: { hosts: Host[]; sessionNames: Record<string, string>; onClose(): void }): React.JSX.Element {
  const confirm = useConfirm()
  const version = useRef(0)
  const operating = useRef(false)
  const [status, setStatus] = useState<AlertAuditStatus | null>(null)
  const [rows, setRows] = useState<AlertAuditSummary[]>([])
  const [detail, setDetail] = useState<AlertAuditRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function refresh(): Promise<void> {
    const id = ++version.current
    try {
      const [next, list] = await Promise.all([window.crow.getAlertAuditStatus(), window.crow.listAlertAudit()])
      if (id !== version.current) return
      setStatus(next); setRows(list)
      if (next.error) setError(next.error)
    } catch { if (id === version.current) setError('No se pudo leer el diagnóstico.') }
  }

  useEffect(() => { void refresh(); return () => { version.current++ } }, [])

  async function operate(action: () => Promise<void>): Promise<void> {
    if (operating.current) return
    operating.current = true; setBusy(true); setError(''); setMessage('')
    const id = ++version.current
    try { await action(); if (id === version.current) await refresh() }
    catch { if (id === version.current) setError('La operación no pudo completarse. Verificá el almacenamiento seguro y los permisos del archivo.') }
    finally { operating.current = false; setBusy(false) }
  }

  async function openRecord(id: string): Promise<void> {
    const request = ++version.current
    setDetail(null); setError('')
    try {
      const row = await window.crow.getAlertAudit(id)
      if (request !== version.current) return
      if (row) setDetail(row)
      else setError('El registro expiró, fue borrado o no se pudo descifrar.')
    } catch { if (request === version.current) setError('No se pudo abrir el registro.') }
  }

  const terminalLabel = (row: AlertAuditSummary): string => `${hosts.find(host => host.id === row.hostId)?.name || row.hostId.slice(0, 8)} · ${sessionNames[`${row.hostId}:${row.sessionId}`] || row.sessionId.slice(0, 8)}`
  const soundLabel = (row: AlertAuditSummary): string => soundLabels[[...row.sound].reverse().find(item => ['scheduled', 'playback-ended', 'playback-error'].includes(item.outcome))?.outcome || row.sound.at(-1)?.outcome || 'pending']
  return <Modal className="audit-dialog" titleId="audit-title" busy={busy} onClose={onClose}>
    <div className="dialog-heading"><h2 id="audit-title">Diagnóstico de alertas</h2><button className="secondary-button" disabled={busy} onClick={onClose}>Cerrar</button></div>
    <p>Registro local cifrado. Conserva el texto analizado y la justificación breve del modelo durante 7 días; no envía estos registros automáticamente.</p>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!status ? <p role="status">Cargando diagnóstico…</p> : <>
      <label className="hook-toggle"><input type="checkbox" checked={status.enabled} disabled={busy || !status.secureStorageAvailable} onChange={event => { const enabled = event.target.checked; void operate(async () => { setStatus(await window.crow.setAlertAuditEnabled(enabled)) }) }} /><span>Guardar diagnóstico de próximas respuestas<small>Incluye texto potencialmente privado. Desactivar pausa la captura; no borra lo anterior.</small></span></label>
      {!status.secureStorageAvailable && <p className="inline-error">Cifrado de Windows no disponible. No se guardará texto sin cifrar.</p>}
      <div className="audit-actions">
        <button className="secondary-button" disabled={busy} onClick={() => void operate(async () => { setDetail(null) })}>Actualizar</button>
        <button className="secondary-button" disabled={busy || !rows.length} onClick={() => void operate(async () => {
          if (!await confirm({ message: 'El JSON exportado contendrá respuestas privadas SIN cifrar. No lo subas a un repositorio ni lo compartas sin revisarlo.', accept: 'Elegir dónde exportar' })) return
          const result = await window.crow.exportAlertAudit()
          if (!result.canceled) setMessage('Exportación completada. El archivo exportado no se elimina con la retención de Crow.')
        })}>Exportar todos…</button>
        <button className="danger-button" disabled={busy || !status.count} onClick={() => void operate(async () => {
          if (!await confirm({ message: '¿Borrar todos los registros de diagnóstico de esta PC?', accept: 'Borrar registros', danger: true })) return
          await window.crow.clearAlertAudit(); setDetail(null)
        })}>Borrar registros</button>
        <small>{status.count} registros · se muestran los últimos 100</small>
      </div>
      {message && <p role="status">{message}</p>}
      <div className="audit-layout"><div className="audit-list" aria-label="Registros de alertas">
        {!rows.length && <p>Sin registros. Activá el diagnóstico y esperá una nueva respuesta; no recupera conversaciones anteriores.</p>}
        {rows.map(row => <button key={row.id} className={`audit-row ${detail?.id === row.id ? 'selected' : ''}`} disabled={busy} onClick={() => void openRecord(row.id)}><strong>{terminalLabel(row)}</strong><span>{row.classification?.decision || 'Sin decisión'} · {row.classification?.source || 'Sin clasificar'}</span><small>{new Date(row.receivedAt).toLocaleString()}</small><small>{soundLabel(row)}</small></button>)}
      </div><div className="audit-detail">
        {!detail ? <p>Seleccioná un registro para comparar el texto con la decisión y el estado del sonido.</p> : <>
          <h3>{terminalLabel(detail)}</h3><dl>
            {detail.noticeEmitted === false && <><dt>Entrega del aviso</dt><dd>No se emitió: terminal/aviso eliminado o análisis interrumpido.</dd></>}
            <dt>Modelo solicitado / reportado</dt><dd>{detail.requestedModel} / {detail.reportedModel || 'No informado por la API'}</dd>
            <dt>Decisión / origen</dt><dd>{detail.classification?.decision} / {detail.classification?.source}</dd>
            <dt>Motivo declarado</dt><dd>{auditReasons[detail.reasonCode || 'not_reported']}</dd>
            <dt>Justificación breve del modelo</dt><dd>{detail.explanation || 'No informó una justificación.'}</dd>
            <dt>Diagnóstico del clasificador</dt><dd>{detail.classification?.detail}</dd>
            {detail.errorCode && <><dt>Etapa / código de error</dt><dd>{detail.stage || '—'} / {detail.errorCode}{detail.transportCause ? ` · transporte: ${detail.transportCause}` : ''}</dd></>}
            {(detail.responseBytes !== undefined || detail.contentChars !== undefined || detail.finishReason !== undefined) && <><dt>Respuesta de la API</dt><dd>{detail.responseBytes ?? '—'} bytes / {detail.contentChars ?? '—'} caracteres de contenido · finish_reason: {detail.finishReason || 'No informado'}{detail.finishReason === 'length' ? ' (límite reportado; no prueba la causa del fallo)' : ''}</dd></>}
            <dt>Cola / API / HTTP</dt><dd>{detail.queueMs ?? '—'} ms / {detail.inferenceMs ?? '—'} ms / {detail.httpStatus ?? '—'}</dd>
            <dt>Evento remoto / recepción local</dt><dd>{detail.eventAt} / {detail.receivedAt}</dd>
            <dt>Prompt / texto</dt><dd>{detail.promptVersion} · {detail.inputChars} caracteres{detail.inputTruncated ? ' · texto truncado' : ''}{detail.inputRedacted ? ' · secretos detectados ocultos' : ''}</dd>
          </dl>
          <h4>Sonido</h4><ul>{detail.sound.map((item, index) => <li key={index}>{new Date(item.at).toLocaleTimeString()} · {soundLabels[item.outcome]}</li>)}</ul>
          <small>Programado/finalizado describe Web Audio; no confirma el volumen de Windows ni que se haya oído en los altavoces. La justificación del modelo puede ser incorrecta.</small>
          <h4>Texto recibido para análisis</h4><pre>{detail.input || '(No llegó texto final)'}</pre>
        </>}
      </div></div>
      <small>Máximo 500 eventos o 20 MiB. La retención se aplica al abrir Crow y cada minuto mientras está abierto. Un archivo exportado queda bajo tu control.</small>
    </>}
  </Modal>
}
