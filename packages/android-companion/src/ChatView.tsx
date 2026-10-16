import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { App } from '@capacitor/app'
import { Clipboard } from '@capacitor/clipboard'
import { ArrowDown, Copy, RefreshCw, Send } from 'lucide-react'
import type { MobileChatMessage, MobileChatPage, MobileSession } from '../../../src/shared/mobile-companion'
import { Gateway, api, type GatewayProfile } from './native'
import { encodeInput, inputByteLength, MAX_INPUT_BYTES } from './protocol.mjs'
import { boundChatWindow, chatInputAllowed, chatReplyProgress, confirmedChatEcho, definiteChatSendFailure, mergeChatMessages, singleLineChatInput, splitChatMarkdown } from './chat-model.mjs'
import { createChatSync } from './chat-sync.mjs'

const CHAT_PAGE_SIZE = 100
const CHAT_WINDOW_SIZE = 200
const CHAT_POLL_MS = 10000 // Recovery only; live state frames trigger immediate reads.
type ChatStreamState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
type OutgoingMessage = { content: string; afterSeq: number; status: 'sending' | 'delivered' | 'processing' | 'unknown' | 'failed' | 'answered' }

function agentName(agent: string) { return agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent }

function inlineText(value: string) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[([^\]\n]+)\]\(([^)\s]+)\))/g
  const parts: ReactNode[] = []
  let cursor = 0, index = 0
  for (const match of value.matchAll(pattern)) {
    const offset = match.index ?? cursor
    if (offset > cursor) parts.push(<span key={index++}>{value.slice(cursor, offset)}</span>)
    const token = match[0]
    if (token.startsWith('`')) parts.push(<code key={index++} className="chat-inline-code">{token.slice(1, -1)}</code>)
    else if (token.startsWith('**') || token.startsWith('__')) parts.push(<strong key={index++}>{token.slice(2, -2)}</strong>)
    else {
      const label = match[2], href = match[3]
      let safeURL = ''
      try { const url = new URL(href); if (url.protocol === 'http:' || url.protocol === 'https:') safeURL = url.href } catch { /* keep unsafe or malformed links inert */ }
      parts.push(safeURL ? <a key={index++} href={safeURL} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={index++}>{token}</span>)
    }
    cursor = offset + token.length
  }
  if (cursor < value.length || !parts.length) parts.push(<span key={index}>{value.slice(cursor)}</span>)
  return parts
}

function MessageContent({ content, onCopy }: { content: string; onCopy(value: string): void }) {
  const blocks = splitChatMarkdown(content) as Array<{ type: 'paragraph' | 'heading' | 'list' | 'code'; level?: number; ordered?: boolean; items?: string[]; language?: string; content?: string }>
  return <div className="chat-message-content">{blocks.map((block, index) => {
    if (block.type === 'code') return <div className="chat-code-block" key={index}><div className="chat-code-heading"><span>{block.language || 'Código'}</span><button aria-label="Copiar bloque de código" onClick={() => onCopy(block.content || '')}><Copy size={16} aria-hidden="true" /> Copiar</button></div><pre><code>{block.content}</code></pre></div>
    if (block.type === 'heading') { const Heading = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5'; return <Heading key={index}>{inlineText(block.content || '')}</Heading> }
    if (block.type === 'list') { const List = block.ordered ? 'ol' : 'ul'; return <List key={index}>{(block.items || []).map((item, itemIndex) => <li key={itemIndex}>{inlineText(item)}</li>)}</List> }
    return <p key={index}>{inlineText(block.content || '')}</p>
  })}</div>
}

export function ChatView({ profile, hostId, session, onBack, onState, isActive = true }: { profile: GatewayProfile; hostId: string; session: MobileSession; onBack(): void; onState(info: MobileSession): void; isActive?: boolean }) {
  const list = useRef<HTMLDivElement>(null), cursor = useRef(0), before = useRef(0)
  const active = useRef(true), followLatest = useRef(true), pendingOlderAnchor = useRef<{ id: string; offset: number } | null>(null)
  const historySync = useRef<ReturnType<typeof createChatSync> | null>(null)
  const connection = useRef(''), retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onStateRef = useRef(onState)
  onStateRef.current = onState
  const [messages, setMessages] = useState<MobileChatMessage[]>([]), [hasOlder, setHasOlder] = useState(false)
  const [historyReady, setHistoryReady] = useState(false)
  const [streamState, setStreamState] = useState<ChatStreamState>('connecting'), [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [unread, setUnread] = useState(0), [copyMessage, setCopyMessage] = useState(''), [awaitingAgent, setAwaitingAgent] = useState(false)
  const [outgoing, setOutgoing] = useState<OutgoingMessage | null>(null)
  const [recoveryAvailable, setRecoveryAvailable] = useState(false), [manualSendOverride, setManualSendOverride] = useState(false), [announcement, setAnnouncement] = useState('')
  const sendLock = useRef(false), sawAgentBusy = useRef(false)
  const replyPending = useRef<{ content: string; afterSeq: number; userSeq?: number } | null>(null)
  const canOperate = session.canOperate && !session.readOnly && profile.device.capabilities.input && session.state === 'running'
  const agentReady = session.agentState !== 'working'
  const canSend = historyReady && chatInputAllowed(session, profile.device.capabilities, streamState === 'connected', awaitingAgent, manualSendOverride)

  useEffect(() => {
    if (!awaitingAgent && (agentReady || !canOperate)) { setRecoveryAvailable(false); return }
    const timer = window.setTimeout(() => setRecoveryAvailable(true), 30000)
    return () => clearTimeout(timer)
  }, [agentReady, awaitingAgent, canOperate])

  useEffect(() => {
    if (!awaitingAgent) return
    if (!agentReady) { sawAgentBusy.current = true; setOutgoing(previous => previous && previous.status !== 'unknown' ? { ...previous, status: 'processing' } : previous) }
    else if (sawAgentBusy.current) { sawAgentBusy.current = false; setManualSendOverride(false); setAwaitingAgent(false) }
  }, [agentReady, awaitingAgent])

  useEffect(() => { if (agentReady && manualSendOverride) setManualSendOverride(false) }, [agentReady, manualSendOverride])

  const acceptPage = useCallback((page: MobileChatPage, mode: 'initial' | 'older' | 'newer') => {
    if (replyPending.current) {
      const progress = chatReplyProgress(replyPending.current, page.messages)
      replyPending.current = progress.answered ? null : progress
      if (progress.userSeq) setError('') // A durable user hook resolves an uncertain send.
      if (progress.answered) { sawAgentBusy.current = false; setManualSendOverride(false); setAwaitingAgent(false); setOutgoing(previous => previous ? { ...previous, status: 'answered' } : null); setNotice('Respuesta recibida.') }
    }
    setOutgoing(previous => confirmedChatEcho(previous, page.messages) ? null : previous)
    if (mode === 'older') {
      const element = list.current
      if (element) {
        const containerTop = element.getBoundingClientRect().top
        const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.getBoundingClientRect().bottom > containerTop)
        if (anchor?.dataset.messageId) pendingOlderAnchor.current = { id: anchor.dataset.messageId, offset: anchor.getBoundingClientRect().top - containerTop }
      }
      setMessages(previous => boundChatWindow(mergeChatMessages(page.messages, previous), CHAT_WINDOW_SIZE, 'earliest'))
      setHasOlder(page.hasMore)
      before.current = page.nextBefore || before.current
      return
    }
    const shouldFollow = mode === 'initial' || (list.current ? list.current.scrollHeight - list.current.clientHeight - list.current.scrollTop < 96 : true)
    const previousCursor = cursor.current
    if (mode === 'newer' && isActive) {
      const newAnswers = page.messages.filter(item => item.role === 'assistant' && item.seq > previousCursor)
      if (newAnswers.length) {
        const latest = newAnswers[newAnswers.length - 1]
        const excerpt = latest.content.replace(/\s+/g, ' ').trim().slice(0, 120)
        setAnnouncement(`Nueva respuesta de ${agentName(session.agent)}${excerpt ? `: ${excerpt}` : '.'} (${newAnswers.length} mensaje${newAnswers.length === 1 ? '' : 's'}).`)
      }
    }
    followLatest.current = shouldFollow
    if (mode === 'newer' && !shouldFollow) {
      cursor.current = Math.max(cursor.current, ...page.messages.map(item => item.seq))
      setUnread(value => value + page.messages.filter(item => item.seq > previousCursor).length)
      return
    }
    setMessages(previous => {
      const next = boundChatWindow(mode === 'initial' ? page.messages : mergeChatMessages(previous, page.messages), CHAT_WINDOW_SIZE, 'latest')
      if (next.length) before.current = next[0].seq
      return next
    })
    if (mode === 'initial') { setHasOlder(page.hasMore); setUnread(0); cursor.current = 0; before.current = page.nextBefore || 0 }
    if (page.messages.length) {
      cursor.current = Math.max(cursor.current, ...page.messages.map(item => item.seq))
      if (!before.current || mode === 'initial') before.current = page.nextBefore || page.messages[0].seq
      if (mode === 'newer' && page.messages[0].seq > 1) setHasOlder(true)
    }
  }, [isActive, session.agent])
  const acceptPageRef = useRef(acceptPage)
  acceptPageRef.current = acceptPage

  const fetchPage = useCallback(async (mode: 'initial' | 'older' | 'newer') => {
    if (mode !== 'older' || before.current) await historySync.current?.request(mode)
  }, [])
  const fetchLatest = useCallback(() => fetchPage('initial'), [fetchPage])

  useEffect(() => {
    if (!isActive) { active.current = false; return }
    active.current = true
    const sync = createChatSync({
      read: async (mode: string) => {
        const query = new URLSearchParams({ hostId, sessionId: session.id, limit: String(CHAT_PAGE_SIZE) })
        if (mode === 'older') query.set('before', String(before.current))
        else if (mode === 'newer' && cursor.current) query.set('after', String(cursor.current))
        return api<MobileChatPage>(profile.id, `/api/v1/chat?${query}`)
      },
      accept: (page: MobileChatPage, mode: 'initial' | 'older' | 'newer') => { acceptPageRef.current(page, mode); if (mode === 'initial') setHistoryReady(true); setHistoryError('') },
      error: (reason: unknown) => setHistoryError(`No se pudo actualizar la conversación: ${reason instanceof Error ? reason.message : String(reason)}`),
      loading: (value: boolean, mode: string) => { if (mode !== 'newer') setLoading(value) },
    })
    historySync.current = sync
    setHistoryReady(false)
    followLatest.current = true
    void sync.request('initial')
    let disposed = false, retries = 0
    const handles: { remove(): Promise<void> }[] = []
    const close = () => {
      const id = connection.current
      connection.current = ''
      if (id) void Gateway.closeStream({ connectionId: id })
      setStreamState('disconnected')
    }
    const schedule = () => {
      if (disposed || !active.current) return
      clearTimeout(retryTimer.current)
      retryTimer.current = setTimeout(() => void connect(), Math.min(15000, 1000 * 2 ** Math.min(retries++, 4)))
    }
    const connect = async () => {
      if (disposed || !active.current) return
      close()
      setStreamState(retries ? 'reconnecting' : 'connecting')
      const id = crypto.randomUUID()
      connection.current = id
      try {
        await Gateway.openStream({ profileId: profile.id, hostId, sessionId: session.id, from: session.seq, mode: 'chat', connectionId: id })
        if (disposed || connection.current !== id) await Gateway.closeStream({ connectionId: id })
      } catch {
        if (disposed || connection.current !== id) return
        setStreamState('reconnecting')
        schedule()
      }
    }
    const setup = async () => {
      try {
        handles.push(await Gateway.addListener('stream', event => {
          if (disposed || event.profileId !== profile.id || event.connectionId !== connection.current) return
          if (event.status === 'revoked') { active.current = false; clearTimeout(retryTimer.current); close(); setStreamState('disconnected'); setError('Vínculo revocado o vencido. Volvé a vincular desde Windows.'); return }
          if (event.status === 'disconnected') { setStreamState('reconnecting'); schedule(); return }
          if (!event.data) return
          try {
            const frame = JSON.parse(event.data)
            if (frame.type === 'ready') { retries = 0; setStreamState('connected'); void fetchPage('newer'); return }
            if (frame.type === 'state' && frame.info) { onStateRef.current(frame.info); void fetchPage('newer') }
            if (frame.type === 'disconnected') { setStreamState('reconnecting'); schedule() }
          } catch { setStreamState('reconnecting'); schedule() }
        }))
        handles.push(await App.addListener('appStateChange', state => {
          active.current = state.isActive
          clearTimeout(retryTimer.current)
          if (state.isActive) { void connect(); void fetchPage('initial') } else close()
        }))
        if (disposed) { for (const handle of handles) await handle.remove(); return }
        await connect()
      } catch (reason) {
        if (disposed) return
        for (const handle of handles) void handle.remove()
        handles.length = 0
        setStreamState('disconnected')
        setError(`No se pudo iniciar el vínculo de la conversación: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    }
    void setup()
    const poll = window.setInterval(() => {
      if (active.current && document.visibilityState !== 'hidden') void fetchPage('newer')
    }, CHAT_POLL_MS)
    return () => {
      disposed = true; active.current = false; clearInterval(poll); clearTimeout(retryTimer.current); close()
      sync.dispose(); if (historySync.current === sync) historySync.current = null
      for (const handle of handles) void handle.remove()
    }
  }, [fetchPage, hostId, isActive, profile.id, session.id])

  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const anchor = pendingOlderAnchor.current
    if (anchor) {
      const target = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === anchor.id)
      if (target) element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
      pendingOlderAnchor.current = null
    } else if (followLatest.current) {
      element.scrollTop = element.scrollHeight
      setUnread(0)
    }
  }, [isActive, messages, outgoing])

  useEffect(() => {
    if (!isActive || !list.current) return
    const element = list.current
    const observer = new ResizeObserver(() => { if (followLatest.current) element.scrollTop = element.scrollHeight })
    observer.observe(element)
    return () => observer.disconnect()
  }, [isActive])

  async function send() {
    if (!draft.trim() || sending || sendLock.current || !canSend) return
    if (inputByteLength(draft) > MAX_INPUT_BYTES) { setError(`El mensaje supera ${MAX_INPUT_BYTES} bytes UTF-8. Acortalo; no se divide ni se reenvía automáticamente.`); return }
    const id = connection.current, text = draft, singleLineText = singleLineChatInput(draft)
    if (!id) return
    if (!singleLineText) return
    sendLock.current = true
    setSending(true); setError(''); setNotice(''); sawAgentBusy.current = false
    followLatest.current = true
    if (list.current) list.current.scrollTop = list.current.scrollHeight
    setUnread(0); setAwaitingAgent(true)
    setOutgoing({ content: singleLineText, afterSeq: cursor.current, status: 'sending' })
    replyPending.current = { content: singleLineText, afterSeq: cursor.current }
    try {
      await Gateway.send({ connectionId: id, type: 'input', data: encodeInput(singleLineText + '\r') })
      if (connection.current !== id) throw new Error('La conexión cambió durante el envío. Verificá si el mensaje llegó antes de repetirlo.')
      setDraft(value => value === text ? '' : value)
      setOutgoing(previous => previous?.status === 'sending' ? { ...previous, status: 'delivered' } : previous)
      setManualSendOverride(false)
      setNotice(!replyPending.current ? 'Respuesta recibida.' : /\r|\n/.test(text) ? 'Recibido como una sola instrucción; los saltos de línea se convirtieron en espacios.' : 'Recibido por la terminal.')
      void fetchPage('initial')
    } catch (reason) {
      if (!replyPending.current || replyPending.current.userSeq) {
        // The HTTP acknowledgement can be lost after the agent's user hook
        // already proved receipt. Never ask the user to repeat that prompt.
        setDraft(value => value === text ? '' : value)
        setError(''); setNotice('El historial confirmó la recepción. No se repite el envío.')
      } else {
        const definite = definiteChatSendFailure(reason)
        if (definite) { setAwaitingAgent(false); replyPending.current = null }
        setOutgoing(previous => previous ? { ...previous, status: definite ? 'failed' : 'unknown' } : null)
        setError(`${reason instanceof Error ? reason.message : String(reason)} Verificá la conversación antes de volver a intentar.`)
      }
    } finally { sendLock.current = false; setSending(false) }
  }

  async function copyCode(value: string) {
    try { await Clipboard.write({ string: value }); setCopyMessage('Código copiado.'); setTimeout(() => setCopyMessage(''), 1800) }
    catch { setCopyMessage('No se pudo copiar el código.'); setTimeout(() => setCopyMessage(''), 2500) }
  }

  return <section className="chat-page">
    <div className="chat-heading">
      <button className="terminal-back" onClick={onBack} aria-label="Volver a las terminales">← <span>Volver</span></button>
      <div className="chat-identity"><strong>{session.name || 'Conversación'}</strong><small>{agentName(session.agent)} · {session.id.slice(0, 8)}</small></div>
      <span className={`chat-status ${streamState}`} role="status">{streamState === 'connected' ? 'En línea' : streamState === 'connecting' ? 'Conectando…' : streamState === 'reconnecting' ? 'Reconectando…' : 'Desconectada'}</span>
    </div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <div className="chat-transcript" ref={list} role="region" tabIndex={0} onScroll={event => { const element = event.currentTarget; if (!isActive || !element.clientHeight) return; followLatest.current = element.scrollHeight - element.clientHeight - element.scrollTop < 96; if (followLatest.current) setUnread(0) }} aria-label="Mensajes de la conversación" aria-live="off">
      {hasOlder && <button className="chat-older" disabled={loading} onClick={() => void fetchPage('older')}>{loading ? 'Cargando…' : 'Cargar mensajes anteriores'}</button>}
      {loading && messages.length === 0 && <p className="chat-empty">Cargando conversación…</p>}
      {!loading && messages.length === 0 && <p className="chat-empty">Todavía no hay mensajes estructurados. Escribí cuando {agentName(session.agent)} esté esperando una instrucción; las próximas respuestas se guardarán acá.</p>}
      {messages.map(item => <article className={`chat-message ${item.role}`} key={item.id} data-message-id={item.id}>
        <div className="chat-message-meta"><strong>{item.role === 'user' ? 'Vos' : agentName(session.agent)}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        {item.truncated && <p className="chat-truncated" role="note">Mensaje recortado por el límite del historial.</p>}
        <MessageContent content={item.content} onCopy={value => void copyCode(value)} />
      </article>)}
      {outgoing && <article className={`chat-message user outgoing-${outgoing.status}`}><div className="chat-message-meta"><strong>Vos</strong><span role="status">{outgoing.status === 'sending' ? 'Enviando…' : outgoing.status === 'unknown' ? 'Envío sin confirmar' : outgoing.status === 'failed' ? 'No enviado' : outgoing.status === 'processing' ? 'Agente trabajando' : outgoing.status === 'answered' ? 'Respuesta recibida' : 'Recibido por la terminal'}</span></div><p>{outgoing.content}</p></article>}
    </div>
    {(unread > 0 || (messages.length > 0 && cursor.current > messages[messages.length - 1].seq)) && <button className="chat-latest" disabled={loading} onClick={() => void fetchLatest()}><ArrowDown size={16} aria-hidden="true" /> {unread > 0 ? `${unread} mensaje${unread === 1 ? '' : 's'} nuevo${unread === 1 ? '' : 's'}` : 'Ir al final'}</button>}
    {(error || historyError) && <div className="chat-inline-error" role="alert"><span>{error || historyError}</span><button type="button" aria-label="Descartar aviso del chat" onClick={() => { setError(''); setHistoryError('') }}>Cerrar</button></div>}
    {(copyMessage || (notice && !awaitingAgent)) && <p className="chat-inline-notice" role="status">{copyMessage || notice}</p>}
    {!canOperate && <p className="chat-compose-help">Esta terminal está en modo de solo lectura. Podés consultar el historial cuando esté disponible.</p>}
     {canOperate && awaitingAgent && <p className="chat-compose-help chat-activity" role="status">{!agentReady ? `${agentName(session.agent)} está trabajando…` : sending ? 'Enviando a la terminal…' : outgoing?.status === 'unknown' ? 'Resultado del envío sin confirmar. No se vuelve a enviar automáticamente.' : 'Recibido por la terminal; esperando actividad del agente…'}</p>}
     {canOperate && recoveryAvailable && <div className="chat-recovery"><p>¿El estado no avanza? Revisá Terminal para confirmar que el agente terminó y que tu mensaje llegó.</p><button type="button" onClick={() => { setAwaitingAgent(false); setManualSendOverride(true); setRecoveryAvailable(false); setNotice('Habilitaste el envío manual tras revisar Terminal. No repitas la instrucción anterior.') }}>Ya revisé Terminal; habilitar envío</button></div>}
     {canOperate && !agentReady && !awaitingAgent && !manualSendOverride && <p className="chat-compose-help" role="status">{agentName(session.agent)} está trabajando. Podés preparar tu próximo mensaje.</p>}
     {canOperate && (!session.agentState || session.agentState === 'unknown') && !awaitingAgent && <p className="chat-compose-help">Estado del agente sin confirmar. El envío va a la misma terminal; no se ejecuta en otra sesión.</p>}
     {canOperate && manualSendOverride && !agentReady && <p className="chat-compose-help" role="status">Envío manual habilitado por vos. Confirmá que el agente terminó en Terminal antes de enviar; esto no reenvía el mensaje anterior.</p>}
    <form className="chat-compose" onSubmit={event => { event.preventDefault(); void send() }}>
       <label className="sr-only" htmlFor="chat-draft">Escribí un mensaje para {agentName(session.agent)}</label>
       <textarea id="chat-draft" rows={2} value={draft} disabled={!canOperate} placeholder={awaitingAgent || !agentReady ? 'Prepará tu próximo mensaje…' : `Escribí a ${agentName(session.agent)}…`} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void send() } }} />
      <button className="primary chat-send" type="submit" disabled={!canSend || sending || !draft.trim()} aria-label="Enviar mensaje"><Send size={19} aria-hidden="true" />{sending ? 'Enviando' : 'Enviar'}</button>
    </form>
    <div className="chat-toolbar"><span>{draft ? `${inputByteLength(draft)} / ${MAX_INPUT_BYTES} bytes` : 'Enter agrega una línea · Ctrl+Enter envía'}</span><button aria-label="Actualizar conversación" disabled={loading} onClick={() => void fetchPage('newer')}><RefreshCw size={17} aria-hidden="true" /> Actualizar</button></div>
  </section>
}
