import { useState } from 'react'
import type { MobileSession } from '../../../src/shared/mobile-companion'
import { terminalTitle } from './protocol.mjs'
import { chatProbeReport, createChatProbe } from './chat-probe.mjs'

type Probe = ReturnType<typeof createChatProbe>
const outcomes: Record<string, string> = {
  running: 'Prueba en curso (máximo 90 segundos).', passed: 'Envío y respuesta verificados.',
  'acceptance-timeout': 'El agente no confirmó la aceptación. Revisá si el texto quedó en el borrador de Terminal.',
  'response-timeout': 'El agente aceptó el mensaje, pero no recibimos su respuesta a tiempo.',
  'unexpected-response': 'Hubo respuesta, pero no coincidió con la instrucción de prueba.',
  'not-sent': 'La conexión rechazó el envío antes de escribir el texto.',
  cancelled: 'Dejaste de observar. El mensaje enviado no se deshace y el agente no se detiene.',
}

export function ChatTestLauncher({ sessions, connected, canInput, canPair, onPair, onOpen }: { sessions: MobileSession[]; connected: boolean; canInput: boolean; canPair: boolean; onPair(): void; onOpen(session: MobileSession, origin: HTMLButtonElement): void }) {
  const [selected, setSelected] = useState('')
  const choices = sessions.filter(item => item.canOperate && !item.readOnly && item.chatAvailable === true && item.state === 'running' && ['claude', 'codex'].includes(item.agent))
  const session = choices.find(item => item.id === selected)
  return <section className="card chat-test-launcher" aria-labelledby="chat-test-title">
    <h2 id="chat-test-title">Pruebas de chat</h2>
    <p>Podés vincular el emulador usando una imagen del QR de Windows. Se usan los mismos permisos del vínculo normal; no hace falta SSH.</p>
    <button type="button" disabled={!canPair} onClick={onPair}>Vincular emulador con QR</button>
    <label htmlFor="chat-test-session">Terminal de prueba del servidor seleccionado</label>
    <select id="chat-test-session" value={session?.id || ''} disabled={!connected || !canInput} onChange={event => setSelected(event.target.value)}>
      <option value="">Elegí una terminal dedicada a pruebas</option>
      {choices.map(item => <option key={item.id} value={item.id}>{terminalTitle(item)}{item.agentState === 'working' ? ' · ocupada' : ''}</option>)}
    </select>
    {!choices.length && <p>No hay terminales de chat operables. Creá una para pruebas desde Crow y actualizá la lista.</p>}
    <button type="button" className="primary" disabled={!connected || !canInput || !session || session.agentState === 'working'} onClick={event => { if (session) onOpen(session, event.currentTarget) }}>Abrir prueba de envío</button>
    <small>Elegirla no envía nada. Tendrás que autorizar un único mensaje dentro del chat.</small>
  </section>
}

export function ChatProbePanel({ probe, initialOpen, canRun, onRun, onStop, onCopy }: { probe: Probe | null; initialOpen: boolean; canRun: boolean; onRun(): void; onStop(): void; onCopy(value: string): void }) {
  const [open, setOpen] = useState(initialOpen), [confirmed, setConfirmed] = useState(false)
  const report = probe ? chatProbeReport(probe) : null
  const time = (value: number | null) => value === null ? 'Pendiente' : `${value} ms`
  const running = probe?.outcome === 'running'
  return <details className="chat-diagnostics" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Prueba de envío y respuesta</summary>
    <div className="chat-diagnostics-body">
      <p>Usá una terminal dedicada, sin tareas ni texto pendiente. Se pedirá una respuesta breve con un código único. Consume cuota y no garantiza que el agente obedezca; no se envían comandos de sistema.</p>
      <label className="check"><input id="chat-probe-consent" type="checkbox" checked={confirmed} disabled={running} onChange={event => setConfirmed(event.target.checked)} />Revisé Terminal: está libre y autorizo un mensaje de prueba.</label>
      <button type="button" id="chat-probe-run" className="primary" disabled={!confirmed || !canRun || running} onClick={() => { setConfirmed(false); onRun() }}>Enviar una prueba</button>
      {!canRun && !running && <small>Esperá la conexión y que el agente esté libre. El borrador del chat debe estar vacío.</small>}
      {probe && report && <>
        <p className="chat-probe-result" role="status">{outcomes[probe.outcome]}</p>
        <ol aria-label="Etapas de la prueba"><li>Entrega a terminal: {report.writtenMs === null && probe.acceptedAt !== null ? 'Confirmada por el agente, sin ACK de transporte' : time(report.writtenMs)}</li><li>Aceptación del agente: {time(report.acceptedMs)}</li><li>Respuesta esperada: {time(report.responseMs)}</li></ol>
        {probe.sendError && <p>Hubo un error durante el envío. No se reenvió; la confirmación se busca en el historial.</p>}
        {running && <button type="button" onClick={onStop}>Dejar de observar (no detiene al agente)</button>}
        <button type="button" id="chat-probe-copy" onClick={() => onCopy(JSON.stringify(report, null, 2))}>Copiar informe sin credenciales</button>
      </>}
    </div>
  </details>
}
