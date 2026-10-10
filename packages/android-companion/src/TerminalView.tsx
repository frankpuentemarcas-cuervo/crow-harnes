import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Clipboard } from '@capacitor/clipboard'
import { App } from '@capacitor/app'
import { Keyboard } from '@capacitor/keyboard'
import type { MobileSession } from '../../../src/shared/mobile-companion'
import { Gateway, type GatewayProfile } from './native'
import { OutputCursor, encodeInput, decodeOutput, mayOperate, inputByteLength, MAX_INPUT_BYTES, agentLabel } from './protocol.mjs'
import '@xterm/xterm/css/xterm.css'

export function TerminalView({ profile, hostId, session, onBack, onError, onState }: { profile: GatewayProfile; hostId: string; session: MobileSession; onBack(): void; onError(message: string): void; onState(info: MobileSession): void }) {
  const surface = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null), connection = useRef(''), live = useRef(false)
  const [connected, setConnected] = useState(false), [prompt, setPrompt] = useState(''), [pending, setPending] = useState(false), [paste, setPaste] = useState<string | null>(null)
  const canInput = mayOperate(session, profile.device), writable = useRef(canInput)
  writable.current = canInput
  async function send(text: string) {
    if (inputByteLength(text) > MAX_INPUT_BYTES) { onError('El envío supera 2048 bytes UTF-8. Acortá el texto: no se divide ni se envía automáticamente.'); return false }
    if (!live.current || !writable.current) { onError('La terminal no está lista para recibir texto.'); return false }
    const id = connection.current
    try { await Gateway.send({ connectionId: id, type: 'input', data: encodeInput(text) }); return connection.current === id }
    catch (error) { if (connection.current !== id) return false; live.current = false; setConnected(false); onError(`${String(error)} Verificá el resultado antes de repetir el envío.`); return false }
  }
  useEffect(() => {
    if (!surface.current) return
    const instance = new Terminal({ fontFamily: 'ui-monospace, monospace', fontSize: 14, scrollback: 10000, theme: { background: '#101111', foreground: '#f2f5f3', cursor: '#a0edb5' }, allowProposedApi: false, disableStdin: !writable.current })
    const sizing = new FitAddon(); instance.loadAddon(sizing); instance.open(surface.current); sizing.fit(); terminal.current = instance; fit.current = sizing
    const cursor = new OutputCursor(); let disposed = false, active = true, retries = 0, retryTimer: ReturnType<typeof setTimeout> | undefined
    const handles: { remove(): Promise<void> }[] = []
    function detach() { const id = connection.current; connection.current = ''; live.current = false; setConnected(false); if (id) void Gateway.closeStream({ connectionId: id }) }
    function schedule() { if (disposed || !active) return; clearTimeout(retryTimer); retryTimer = setTimeout(() => void connect(), Math.min(15000, 1000 * 2 ** Math.min(retries++, 4))) }
    async function connect() {
      if (disposed || !active) return
      detach(); const id = crypto.randomUUID(); connection.current = id
      try { await Gateway.openStream({ profileId: profile.id, hostId, sessionId: session.id, from: cursor.seq, connectionId: id }); if (disposed || connection.current !== id) await Gateway.closeStream({ connectionId: id }) }
      catch (error) { if (disposed || connection.current !== id) return; onError(String(error)); if (/revocado|vencido|Profile forgotten/.test(String(error))) { active = false; return } schedule() }
    }
    async function setup() {
      handles.push(await Gateway.addListener('stream', event => {
        if (disposed || event.profileId !== profile.id || event.connectionId !== connection.current) return
        if (event.status === 'revoked') { active = false; detach(); onError('Vínculo revocado o vencido. Volvé a vincular desde Windows.'); return }
        if (event.status === 'disconnected') { live.current = false; setConnected(false); schedule(); return }
        if (!event.data) return
        try {
          const frame = JSON.parse(event.data)
          if (frame.type === 'ready') { retries = 0; live.current = true; setConnected(true); return }
          if (cursor.accept(frame)) instance.write(decodeOutput(frame.data))
          if (frame.type === 'state' && frame.info) onState(frame.info)
          if (frame.type === 'disconnected') { detach(); schedule() }
        } catch { onError('Crow envió una trama inválida. Se desconectó la terminal.'); detach(); schedule() }
      }))
      handles.push(await App.addListener('appStateChange', state => { active = state.isActive; clearTimeout(retryTimer); if (!active) detach(); else void connect() }))
      handles.push(await Keyboard.addListener('keyboardDidShow', () => sizing.fit()))
      handles.push(await Keyboard.addListener('keyboardDidHide', () => sizing.fit()))
      if (disposed) { for (const handle of handles) await handle.remove(); return }
      if (!disposed) await connect()
    }
    void setup().catch(error => { if (!disposed) onError(String(error)) })
    const input = instance.onData(data => { if (data.includes('\n') || data.includes('\r') && data.length > 1) setPaste(data); else void send(data) })
    const observer = new ResizeObserver(() => sizing.fit()); observer.observe(surface.current)
    // Local fitting never changes the shared remote PTY; only the explicit Adaptar action does.
    return () => { disposed = true; active = false; clearTimeout(retryTimer); detach(); input.dispose(); observer.disconnect(); for (const handle of handles) void handle.remove(); instance.dispose(); terminal.current = null; fit.current = null }
  }, [profile.id, hostId, session.id])
  useEffect(() => { if (terminal.current) terminal.current.options.disableStdin = !canInput }, [canInput])
  async function submit() { if (!prompt || pending) return; setPending(true); const text = prompt; if (await send(text + '\r')) setPrompt(previous => previous === text ? '' : previous); setPending(false) }
  return <section className="terminal-page">
    <div className="row"><button onClick={onBack}>← Volver</button><div><strong>{agentLabel(session.agent)} · {session.name || session.id.slice(0, 8)}</strong><small role="status">{connected ? canInput ? 'Conectada · mismo proceso' : 'Solo lectura' : 'Desconectada · reanudando salida'}</small></div></div>
    <div className="terminal-surface" ref={surface} aria-label="Salida de terminal remota" />
    <div className="keys" aria-label="Acciones de terminal">
      {[['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B']].map(([label, data]) => <button key={label} disabled={!connected || !canInput} onClick={() => void send(data)}>{label}</button>)}
      <button onClick={() => terminal.current?.focus()} disabled={!canInput}>Teclado</button>
      <button onClick={() => { const text = terminal.current?.getSelection(); if (text) void Clipboard.write({ string: text }).catch(error => onError(String(error))); else onError('Seleccioná texto de la salida primero.') }}>Copiar selección</button>
      <button disabled={!connected || !canInput} onClick={() => void Clipboard.read().then(value => setPaste(value.value)).catch(error => onError(String(error)))}>Pegar…</button>
      <button disabled={!connected || !canInput} onClick={() => { const term = terminal.current; if (term) void Gateway.send({ connectionId: connection.current, type: 'resize', cols: term.cols, rows: term.rows }).catch(error => onError(String(error))) }}>Adaptar terminal</button>
    </div>
    <small>Adaptar cambia el tamaño compartido también en Windows. Volver solo desconecta; no cierra el proceso.</small>
    {canInput && <form className="compose" onSubmit={event => { event.preventDefault(); if (prompt.includes('\n')) setPaste(prompt + '\r'); else void submit() }}><label className="sr-only" htmlFor="prompt">Mensaje al agente</label><textarea id="prompt" rows={2} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Escribí al agente…" /><button className="primary" disabled={!connected || pending || !prompt}>Enviar</button></form>}
    {paste !== null && <PasteConfirmation text={paste} onCancel={() => setPaste(null)} onConfirm={() => { const text = paste; setPaste(null); void send(text).then(sent => { if (sent) setPrompt('') }) }} />}
  </section>
}
function PasteConfirmation({ text, onCancel, onConfirm }: { text: string; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  const tooLong = inputByteLength(text) > MAX_INPUT_BYTES
  return <dialog ref={dialog} aria-labelledby="paste-title" onCancel={event => { event.preventDefault(); onCancel() }}><h2 id="paste-title">Revisá antes de pegar</h2><p>{tooLong ? 'El texto supera 2048 bytes UTF-8. Acortalo antes de pegar: no se divide ni se envía automáticamente.' : /[\r\n]/.test(text) ? 'Hay saltos de línea: pueden ejecutar comandos. Confirmar envía exactamente el texto de abajo.' : 'Se pegará sin agregar Enter.'}</p><pre>{text}</pre><div className="row"><button autoFocus onClick={onCancel}>Cancelar</button><button className="primary" disabled={tooLong} onClick={onConfirm}>Confirmar envío</button></div></dialog>
}
