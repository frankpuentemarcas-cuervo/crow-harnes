import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { normalizeSessionName } from '../../shared/session-list'

export function RenameTerminalDialog({ initialName, onSave, onClose }: {
  initialName: string
  onSave: (name: string) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const saving = useRef(false)
  const [name, setName] = useState(initialName)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.showModal()
    input.current?.focus()
    input.current?.select()
    return () => { element?.close(); previous?.focus() }
  }, [])

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (saving.current) return
    setError('')
    let normalized: string
    try { normalized = normalizeSessionName(name) }
    catch (reason) { setError((reason as Error).message); input.current?.focus(); return }
    saving.current = true
    setBusy(true)
    try { await onSave(normalized); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); input.current?.focus() }
    finally { saving.current = false; setBusy(false) }
  }

  return <dialog ref={dialog} className="dialog-card rename-terminal-dialog" aria-labelledby="rename-terminal-title" onCancel={(event) => {
    event.preventDefault()
    if (!saving.current) onClose()
  }}>
    <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <div className="dialog-heading"><h2 id="rename-terminal-title">Renombrar terminal</h2><button type="button" className="icon-button" aria-label="Cerrar renombrado" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <label htmlFor="terminal-name">Nombre de la terminal</label>
      <input ref={input} id="terminal-name" value={name} placeholder="Por ejemplo: QA o Desarrollador" readOnly={busy} aria-invalid={!!error} aria-describedby={`terminal-name-help terminal-name-count${error ? ' terminal-name-error' : ''}`} onChange={(event) => { setName(event.target.value); setError('') }} />
      <p id="terminal-name-help">Dejalo vacío para volver al nombre del agente. No cambia ni reinicia el proceso remoto.</p>
      <small id="terminal-name-count">{Array.from(name.trim()).length}/48 caracteres</small>
      {error && <div id="terminal-name-error" className="inline-error" role="alert">{error}</div>}
      <div className="dialog-actions"><span /><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></div>
    </form>
  </dialog>
}
