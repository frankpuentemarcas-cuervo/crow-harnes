import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Clipboard } from '@capacitor/clipboard'
import { App } from '@capacitor/app'
import { Keyboard } from '@capacitor/keyboard'
import type { MobileSession } from '../../../src/shared/mobile-companion'
import { Gateway, type GatewayProfile } from './native'
import { OutputCursor, encodeInput, decodeOutput, mayOperate, inputByteLength, MAX_INPUT_BYTES, agentLabel, terminalTitle } from './protocol.mjs'
import { hasScrollableHistory } from './terminal-scroll.mjs'
import '@xterm/xterm/css/xterm.css'

export function TerminalView({ profile, hostId, session, onBack, onError, onState, isActive = true }: { profile: GatewayProfile; hostId: string; session: MobileSession; onBack(): void; onError(message: string): void; onState(info: MobileSession): void; isActive?: boolean }) {
  const surface = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null), connection = useRef(''), live = useRef(false), retryConnection = useRef<() => void>(() => {}), appForeground = useRef(true), streamControl = useRef<{ pause(): void; resume(): void } | null>(null)
  const activeView = useRef(isActive)
  activeView.current = isActive
  const [hasActivated, setHasActivated] = useState(isActive)
  const [connected, setConnected] = useState(false), [streamState, setStreamState] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting'), [resizeMessage, setResizeMessage] = useState(''), [outputGap, setOutputGap] = useState(false), [hasScrollback, setHasScrollback] = useState(false), [screenOnly, setScreenOnly] = useState(false), [prompt, setPrompt] = useState(''), [pending, setPending] = useState(false), [paste, setPaste] = useState<string | null>(null)
  const [resizing, setResizing] = useState(false)
  const canInput = mayOperate(session, profile.device), writable = useRef(canInput)
  writable.current = canInput
  async function send(text: string) {
    if (inputByteLength(text) > MAX_INPUT_BYTES) { onError('El envío supera 2048 bytes UTF-8. Acortá el texto: no se divide ni se envía automáticamente.'); return false }
    if (!live.current || !writable.current) { onError('La terminal no está lista para recibir texto.'); return false }
    const id = connection.current
    try { await Gateway.send({ connectionId: id, type: 'input', data: encodeInput(text) }); return connection.current === id }
    catch (error) { if (connection.current !== id) return false; onError(`${String(error)} Verificá el resultado antes de repetir el envío.`); retryConnection.current(); return false }
  }
  useEffect(() => { if (isActive) setHasActivated(true) }, [isActive])
  useEffect(() => {
    // Chat is the default view. Do not create a zero-sized xterm or consume
    // terminal output until the user opens this tab for the first time.
    if (!hasActivated || !surface.current) return
    const instance = new Terminal({ fontFamily: 'ui-monospace, monospace', fontSize: 14, scrollback: 10000, theme: { background: '#101111', foreground: '#f2f5f3', cursor: '#a0edb5' }, allowProposedApi: false, disableStdin: !writable.current })
    const sizing = new FitAddon(); instance.loadAddon(sizing); instance.open(surface.current); sizing.fit(); terminal.current = instance; fit.current = sizing
    const cursor = new OutputCursor(); let disposed = false, ready = false, blocked = false, active = activeView.current && appForeground.current, retries = 0, retryTimer: ReturnType<typeof setTimeout> | undefined
    const handles: { remove(): Promise<void> }[] = []
    function detach() { const id = connection.current; connection.current = ''; live.current = false; setConnected(false); if (id) void Gateway.closeStream({ connectionId: id }) }
    function schedule() { if (disposed || blocked || !active || !activeView.current || !appForeground.current) return; clearTimeout(retryTimer); retryTimer = setTimeout(() => { retryTimer = undefined; void connect() }, Math.min(15000, 1000 * 2 ** Math.min(retries++, 4))) }
    function pause() { active = false; clearTimeout(retryTimer); retryTimer = undefined; detach(); setStreamState('disconnected') }
    function resume() {
      if (disposed || blocked || !activeView.current || !appForeground.current) { active = false; return }
      if (!ready) { active = true; return }
      if (active && (connection.current || retryTimer !== undefined)) return
      active = true; clearTimeout(retryTimer); retryTimer = undefined; void connect()
    }
    const control = { pause, resume }
    streamControl.current = control
    retryConnection.current = () => { if (disposed || blocked || !active || !activeView.current || !appForeground.current) return; detach(); setStreamState('reconnecting'); schedule() }
    async function connect() {
      if (disposed || blocked || !active || !activeView.current || !appForeground.current) return
      detach(); setStreamState(retries ? 'reconnecting' : 'connecting'); const id = crypto.randomUUID(); connection.current = id
      try { await Gateway.openStream({ profileId: profile.id, hostId, sessionId: session.id, from: cursor.seq, connectionId: id }); if (disposed || connection.current !== id) await Gateway.closeStream({ connectionId: id }) }
      catch (error) { if (disposed || connection.current !== id) return; onError(String(error)); if (/revocado|vencido|Profile forgotten/.test(String(error))) { blocked = true; active = false; setStreamState('disconnected'); return } setStreamState('reconnecting'); schedule() }
    }
    async function setup() {
      handles.push(await Gateway.addListener('stream', event => {
        if (disposed || !activeView.current || !appForeground.current || event.profileId !== profile.id || event.connectionId !== connection.current) return
        if (event.status === 'revoked') { blocked = true; active = false; detach(); setStreamState('disconnected'); onError('Vínculo revocado o vencido. Volvé a vincular desde Windows.'); return }
        if (event.status === 'disconnected') { live.current = false; setConnected(false); setStreamState('reconnecting'); schedule(); return }
        if (!event.data) return
        try {
          const frame = JSON.parse(event.data)
          if (frame.type === 'ready') { retries = 0; live.current = true; setConnected(true); setStreamState('connected'); return }
          if (cursor.accept(frame)) {
            instance.write(decodeOutput(frame.data), () => {
              if (disposed) return
              const activeBuffer = instance.buffer.active
              setHasScrollback(hasScrollableHistory(activeBuffer))
              setScreenOnly(activeBuffer.type === 'alternate')
            })
            if (cursor.lastGap) setOutputGap(true)
          }
          if (frame.type === 'state' && frame.info) onState(frame.info)
          if (frame.type === 'disconnected') { detach(); setStreamState('reconnecting'); schedule() }
        } catch { onError('Crow envió una trama inválida. Se desconectó la terminal.'); detach(); schedule() }
      }))
      handles.push(await App.addListener('appStateChange', state => { appForeground.current = state.isActive; if (state.isActive && activeView.current) resume(); else pause() }))
      handles.push(await Keyboard.addListener('keyboardDidShow', () => { if (activeView.current) sizing.fit() }))
      handles.push(await Keyboard.addListener('keyboardDidHide', () => { if (activeView.current) sizing.fit() }))
      if (disposed) { for (const handle of handles) await handle.remove(); return }
      ready = true
      if (activeView.current && appForeground.current) resume(); else pause()
    }
    void setup().catch(error => { if (!disposed) onError(String(error)) })
    const input = instance.onData(data => { if (data.includes('\n') || data.includes('\r') && data.length > 1) setPaste(data); else void send(data) })
    const observer = new ResizeObserver(() => { if (activeView.current) sizing.fit() }); observer.observe(surface.current)
    // Local fitting never changes the shared remote PTY; only the explicit Adaptar action does.
    return () => { disposed = true; active = false; retryConnection.current = () => {}; if (streamControl.current === control) streamControl.current = null; clearTimeout(retryTimer); detach(); input.dispose(); observer.disconnect(); for (const handle of handles) void handle.remove(); instance.dispose(); terminal.current = null; fit.current = null }
  }, [hasActivated, profile.id, hostId, session.id])
  useLayoutEffect(() => {
    if (!hasActivated) return
    if (isActive && appForeground.current) streamControl.current?.resume()
    else streamControl.current?.pause()
  }, [isActive, hasActivated])
  useEffect(() => { if (terminal.current) terminal.current.options.disableStdin = !canInput }, [canInput])
  useEffect(() => {
    if (!isActive) return
    const frame = requestAnimationFrame(() => fit.current?.fit())
    return () => cancelAnimationFrame(frame)
  }, [isActive])
  async function submit() { if (!prompt || pending) return; setPending(true); const text = prompt; if (await send(text + '\r')) setPrompt(previous => previous === text ? '' : previous); setPending(false) }
  async function resizeRemote() {
    const term = terminal.current
    if (!term || !connected || resizing) return
    const id = connection.current
    setResizing(true)
    try { fit.current?.fit(); await Gateway.send({ connectionId: id, type: 'resize', cols: term.cols, rows: term.rows }); if (connection.current === id) setResizeMessage('Tamaño ajustado para Android y Crow Windows.') }
    catch (error) { if (connection.current === id) { onError(`No se pudo ajustar el tamaño compartido. ${String(error)} No se repite la acción automáticamente.`); retryConnection.current() } }
    finally { setResizing(false) }
  }
  return <section className="terminal-page">
    <div className="terminal-heading">
      <button className="terminal-back" onClick={onBack} aria-label="Volver a las terminales">← <span>Volver</span></button>
      <div className="terminal-identity" title={session.name || `${agentLabel(session.agent)} · ${session.id}`}>
        <strong>{terminalTitle(session)}</strong>
        <small>{session.name ? `${agentLabel(session.agent)} · ${session.id.slice(0, 8)}` : `Sesión ${session.id.slice(0, 8)}`}</small>
      </div>
      <span className={`terminal-status ${streamState === 'connected' ? 'is-connected' : 'is-reconnecting'}`} role="status">{streamState === 'connected' ? canInput ? 'Conectada' : 'Solo lectura' : streamState === 'connecting' ? 'Conectando…' : streamState === 'disconnected' ? 'Sin conexión' : 'Reconectando…'}</span>
    </div>
    {resizeMessage && <p className="terminal-resize-notice" role="status">{resizeMessage}</p>}
    <div className="terminal-surface" ref={surface} role="region" tabIndex={0} aria-label="Salida de terminal remota" onFocus={() => terminal.current?.focus()} />
    {outputGap && <p className="terminal-recovery-warning" role="status" aria-live="polite" aria-atomic="true">Parte de la salida anterior no se pudo recuperar. El búfer remoto es limitado; la terminal continúa desde la salida disponible.</p>}
    {streamState === 'connected' && screenOnly && <p className="terminal-scroll-notice" role="status">Esta pantalla interactiva no conserva historial. El desplazamiento no puede recuperar contenido que ya salió de la pantalla.</p>}
    <details className="terminal-control-panel"><summary aria-label="Mostrar u ocultar controles de terminal">Controles de terminal</summary>
      <div className="terminal-scroll" role="group" aria-label="Desplazamiento del historial de salida">
        <button aria-label="Desplazar salida hacia arriba" disabled={!hasScrollback} onClick={() => terminal.current?.scrollLines(-12)}>↑ Historial</button>
        <button aria-label="Desplazar salida hacia abajo" disabled={!hasScrollback} onClick={() => terminal.current?.scrollLines(12)}>↓ Historial</button>
        <button aria-label="Ir al final de la salida" disabled={!hasScrollback} onClick={() => terminal.current?.scrollToBottom()}>Ir al final</button>
      </div>
      <div className="keys" role="group" aria-label="Teclas para el proceso remoto">
        {[['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B']].map(([label, data]) => <button key={label} aria-label={label === '↑' ? 'Enviar tecla flecha arriba al proceso' : label === '↓' ? 'Enviar tecla flecha abajo al proceso' : undefined} disabled={!connected || !canInput} onClick={() => void send(data)}>{label}</button>)}
        <button onClick={() => terminal.current?.focus()} disabled={!canInput} aria-label="Abrir teclado para la terminal">Teclado</button>
      </div>
      <details className="terminal-actions"><summary>Más acciones</summary>
        <div className="terminal-tools" role="group" aria-label="Herramientas de terminal">
          <button onClick={() => { const text = terminal.current?.getSelection(); if (text) void Clipboard.write({ string: text }).catch(error => onError(String(error))); else onError('Seleccioná texto de la salida primero.') }}>Copiar selección</button>
          <button disabled={!connected || !canInput} onClick={() => void Clipboard.read().then(value => setPaste(value.value)).catch(error => onError(String(error)))}>Pegar…</button>
          <button className="terminal-resize" title="Ajusta las filas y columnas compartidas también en Crow Windows" disabled={!connected || !canInput || resizing} aria-busy={resizing} onClick={() => void resizeRemote()}>{resizing ? 'Ajustando…' : 'Ajustar + Windows'}</button>
        </div>
        <p>Volver no cierra el proceso. Ajustar tamaño modifica esta terminal también en Crow Windows.</p>
      </details>
    </details>
    {canInput && <form className="compose" onSubmit={event => { event.preventDefault(); if (prompt.includes('\n')) setPaste(prompt + '\r'); else void submit() }}><label className="sr-only" htmlFor="prompt">Mensaje al agente</label><textarea id="prompt" rows={2} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Escribí al agente…" /><button className="primary" disabled={!connected || pending || !prompt}>{pending ? 'Enviando…' : 'Enviar'}</button></form>}
    {paste !== null && <PasteConfirmation text={paste} onCancel={() => setPaste(null)} onConfirm={() => { const text = paste; setPaste(null); void send(text).then(sent => { if (sent) setPrompt('') }) }} />}
  </section>
}
function PasteConfirmation({ text, onCancel, onConfirm }: { text: string; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  const tooLong = inputByteLength(text) > MAX_INPUT_BYTES
  return <dialog ref={dialog} aria-labelledby="paste-title" onCancel={event => { event.preventDefault(); onCancel() }}><h2 id="paste-title">Revisá antes de pegar</h2><p>{tooLong ? 'El texto supera 2048 bytes UTF-8. Acortalo antes de pegar: no se divide ni se envía automáticamente.' : /[\r\n]/.test(text) ? 'Hay saltos de línea: pueden ejecutar comandos. Confirmar envía exactamente el texto de abajo.' : 'Se pegará sin agregar Enter.'}</p><pre>{text}</pre><div className="row"><button autoFocus onClick={onCancel}>Cancelar</button><button className="primary" disabled={tooLong} onClick={onConfirm}>Confirmar envío</button></div></dialog>
}
