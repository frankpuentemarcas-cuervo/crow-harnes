import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe2, RotateCw } from 'lucide-react'
import type { ConnectionStatus } from '../../shared/types'

export function BrowserPane({ hostId, root, initialURL, status, onURL }: { hostId: string; root: string; initialURL: string; status: ConnectionStatus; onURL(url: string): void }): React.JSX.Element {
  const [address, setAddress] = useState(initialURL)
  const [frame, setFrame] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const image = useRef<HTMLImageElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const started = useRef(false)
  const refreshing = useRef(false)

  async function navigate(raw: string): Promise<void> {
    if (status !== 'connected') return
    const url = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
    setBusy(true)
    setError('')
    try {
      const result = await window.crow.browserOpen(hostId, root, url)
      setAddress(result.url)
      onURL(result.url)
      started.current = true
      await refresh()
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  async function refresh(): Promise<void> {
    if (status !== 'connected' || refreshing.current) return
    refreshing.current = true
    try {
      const result = await window.crow.browserFrame(hostId, root)
      setFrame(result.data)
      if (result.url && result.url !== 'about:blank') {
        setAddress(result.url)
        onURL(result.url)
      }
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { refreshing.current = false }
  }

  useEffect(() => {
    if (status !== 'connected') return
    let stopped = false
    if (!started.current) void navigate(initialURL)
    const timer = setInterval(() => { if (!stopped) void refresh() }, 1200)
    return () => { stopped = true; clearInterval(timer) }
  }, [hostId, root, status])

  async function action(kind: string, payload?: Record<string, unknown>): Promise<void> {
    try { await window.crow.browserInput(hostId, root, kind, payload); await refresh() }
    catch (reason) { setError(String(reason)) }
  }

  function coordinates(clientX: number, clientY: number): { x: number; y: number } {
    const rect = image.current?.getBoundingClientRect()
    const naturalWidth = image.current?.naturalWidth || 1280
    const naturalHeight = image.current?.naturalHeight || 800
    if (!rect) return { x: 0, y: 0 }
    const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight)
    const left = rect.left + (rect.width - naturalWidth * scale) / 2
    const top = rect.top + (rect.height - naturalHeight * scale) / 2
    return { x: Math.max(0, Math.min(naturalWidth, (clientX - left) / scale)), y: Math.max(0, Math.min(naturalHeight, (clientY - top) / scale)) }
  }

  return <div className="browser-pane">
    <div className="browser-toolbar"><button className="icon-button" title="Atrás" aria-label="Atrás" onClick={() => void action('back')}><ArrowLeft size={16} /></button><button className="icon-button" title="Adelante" aria-label="Adelante" onClick={() => void action('forward')}><ArrowRight size={16} /></button><button className="icon-button" title="Recargar" aria-label="Recargar" onClick={() => void action('reload')}><RotateCw size={16} /></button><form onSubmit={(event) => { event.preventDefault(); void navigate(address) }}><Globe2 size={15} /><input aria-label="Dirección web" value={address} onChange={(event) => setAddress(event.target.value)} spellCheck={false} /><span>en servidor</span></form></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="browser-surface" ref={surface} tabIndex={0} role="application" aria-label="Navegador remoto" onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); void action('enter') }
      else if (event.key === 'Backspace') { event.preventDefault(); void action('backspace') }
      else if (event.key === 'Tab') { event.preventDefault(); void action('tab') }
      else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); void action('text', { text: event.key }) }
    }} onWheel={(event) => { const point = coordinates(event.clientX, event.clientY); void action('scroll', { ...point, delta: event.deltaY }) }}>
      {frame ? <img ref={image} alt="Página renderizada en el servidor" src={frame} draggable={false} onClick={(event) => { surface.current?.focus(); void action('click', coordinates(event.clientX, event.clientY)) }} /> : <div className="browser-placeholder"><Globe2 size={31} /><span>{busy ? 'Abriendo navegador remoto…' : 'Esperando imagen del servidor…'}</span></div>}
    </div>
    <div className="browser-footer">Chromium corre en el host · vista remota de baja frecuencia</div>
  </div>
}
