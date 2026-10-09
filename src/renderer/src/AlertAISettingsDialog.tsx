import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AlertAISettings, AlertAIStatus } from '../../shared/types'
import { Modal } from './Modal'

export function AlertAISettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (settings: AlertAISettings) => void }): React.JSX.Element {
  const form = useRef<HTMLFormElement>(null)
  const errorBox = useRef<HTMLDivElement>(null)
  const [settings, setSettings] = useState<AlertAISettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [autoOpenFreeLLM, setAutoOpenFreeLLM] = useState(true)
  const [baseURL, setBaseURL] = useState('http://127.0.0.1:31415/v1')
  const [model, setModel] = useState('auto')
  const [apiKey, setApiKey] = useState('')
  const [removeKey, setRemoveKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<AlertAIStatus | null>(null)
  const saving = useRef(false)

  useEffect(() => {
    let live = true
    void window.crow.getAlertAISettings().then((value) => {
      if (!live) return
      setSettings(value); setEnabled(value.enabled); setBaseURL(value.baseURL); setModel(value.model)
      setAutoOpenFreeLLM(value.autoOpenFreeLLM !== false)
      if (value.configurationError) setError(value.configurationError)
    }).catch(() => { if (live) setError('No se pudo cargar la configuración de Free LLM.') })
    return () => { live = false }
  }, [])

  useEffect(() => { if (error) errorBox.current?.focus() }, [error])

  async function save(test = false): Promise<void> {
    if (saving.current) return
    saving.current = true
    setBusy(true); setError(''); setStatus(null)
    try {
      const next = await window.crow.saveAlertAISettings({ enabled, autoOpenFreeLLM, baseURL, model, apiKey: apiKey || undefined, removeKey })
      setSettings(next); setApiKey(''); setRemoveKey(false); setBaseURL(next.baseURL); setModel(next.model)
      onSaved(next)
      if (test) {
        const result = await window.crow.testAlertAI()
        setStatus(result)
        if (result.state === 'error') setError(result.detail)
      } else setStatus({ state: 'ok', detail: 'Guardado. Se aplicará a las próximas respuestas.' })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo guardar la configuración.') }
    finally { saving.current = false; setBusy(false) }
  }

  return <Modal className="alert-ai-dialog" titleId="alert-ai-title" busy={busy} onClose={onClose}>
    <form ref={form} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="dialog-heading"><h2 id="alert-ai-title">Alertas inteligentes · Free LLM</h2><button type="button" className="icon-button" disabled={busy} aria-label="Cerrar ajustes de IA" onClick={onClose}><X size={18} aria-hidden="true" /></button></div>
      <p>Crow analiza la última respuesta final para detectar pedidos de autorización, decisiones o información que necesita el agente. Los avisos de progreso y resultados informativos quedan sin sonido.</p>
      {error && <div ref={errorBox} tabIndex={-1} className="inline-error" role="alert">{error}</div>}
      {!settings ? <p role="status">Cargando ajustes…</p> : <>
        <label className="hook-toggle"><input type="checkbox" checked={enabled} disabled={busy || !settings.secureStorageAvailable} onChange={(event) => setEnabled(event.target.checked)} /><span>Activar clasificación por IA<small>Al activarla, autorizás enviar las respuestas a Free LLM y a los proveedores de tu cadena. Una API local NO garantiza un modelo local.</small></span></label>
        <label className="hook-toggle"><input type="checkbox" checked={autoOpenFreeLLM} disabled={busy} onChange={event => setAutoOpenFreeLLM(event.target.checked)} /><span>Abrir Free LLM API al iniciar Crow<small>Después de resolver las llaves SSH, si la IA está activada y la API no responde. Desmarcado, Crow sólo avisa.</small></span></label>
        <label htmlFor="alert-ai-url">URL base local<input id="alert-ai-url" required value={baseURL} disabled={busy} onChange={(event) => setBaseURL(event.target.value)} aria-describedby="alert-ai-url-help" /><small id="alert-ai-url-help">Free LLM debe estar abierto en esta PC Windows. No se consulta desde Linux.</small></label>
        <label htmlFor="alert-ai-model">Modelo o estrategia<input id="alert-ai-model" required value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} aria-describedby="alert-ai-model-help" /><small id="alert-ai-model-help">auto respeta tu cadena. auto:fast prioriza velocidad entre los modelos habilitados.</small></label>
        <label htmlFor="alert-ai-key">Clave unificada de Free LLM<input id="alert-ai-key" type="password" value={apiKey} disabled={busy || removeKey || !settings.secureStorageAvailable} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder={settings.keyPresent ? 'Guardada · dejá vacío para conservarla' : 'Ingresá la clave desde Free LLM'} aria-describedby="alert-ai-key-help" /><small id="alert-ai-key-help">Se guarda cifrada en Windows y no se devuelve a la interfaz. No se incluye en mensajes al modelo.</small></label>
        {settings.keyPresent && <label className="hook-toggle"><input type="checkbox" checked={removeKey} disabled={busy} onChange={(event) => { setRemoveKey(event.target.checked); if (event.target.checked) { setEnabled(false); setApiKey('') } }} /><span>Eliminar la clave guardada al guardar</span></label>}
        {!settings.secureStorageAvailable && <p className="inline-error" role="alert">El almacenamiento seguro no está disponible. No se guardarán claves en texto plano.</p>}
        <p>Si falla la API, se agota el cupo o la clasificación es incierta, se muestra una alerta preventiva con el motivo. Desactivada, Crow conserva las reglas locales.</p>
        {status && <p className="alert-ai-result" role="status">{status.detail}</p>}
        <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy || removeKey || (!apiKey.trim() && !settings.keyPresent)} onClick={() => void save(true)}>{busy ? 'Procesando…' : 'Guardar y probar'}</button><span /><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cerrar</button><button type="submit" className="primary-button" disabled={busy}>Guardar</button></div>
        <small>La prueba envía 3 ejemplos ficticios, no conversaciones reales. Free LLM debe tener modelos disponibles en su cadena.</small>
      </>}
    </form>
  </Modal>
}
