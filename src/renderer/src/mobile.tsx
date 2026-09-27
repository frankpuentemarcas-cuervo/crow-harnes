import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionInfo, TerminalFrame } from '../../shared/types'
import '@xterm/xterm/css/xterm.css'
import './mobile.css'

type HostSummary = { id: string; name: string; status: string }
type ProjectSummary = { id: string; hostId: string; name: string; root: string }
type MobileState = { hosts: HostSummary[]; projects: ProjectSummary[] }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string }
    throw new Error(message.error || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

function encodeInput(value: string): string {
  const data = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeOutput(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function TerminalView({ hostId, sessionId, onInfo }: { hostId: string; sessionId: string; onInfo(info: SessionInfo): void }): React.JSX.Element {
  const surface = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const [ready, setReady] = useState(false)
  const [retry, setRetry] = useState(0)
  const [prompt, setPrompt] = useState('')

  function send(data: string): void {
    if (socket.current?.readyState === WebSocket.OPEN && ready) socket.current.send(JSON.stringify({ type: 'input', data: encodeInput(data) }))
  }

  useEffect(() => {
    if (!surface.current) return
    const instance = new Terminal({
      fontFamily: 'Cascadia Code, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.3,
      scrollback: 10000, convertEol: false,
      theme: { background: '#0a0a0a', foreground: '#fafafa', cursor: '#e5e5e5', selectionBackground: '#404040' }
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(surface.current)
    fit.fit()
    terminal.current = instance
    let closed = false
    let remoteReady = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let activeSocket: WebSocket | undefined
    const sendResize = (): void => {
      if (remoteReady && activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify({ type: 'resize', cols: instance.cols, rows: instance.rows }))
    }
    const observer = new ResizeObserver(() => { fit.fit(); sendResize() })
    observer.observe(surface.current)
    const input = instance.onData((data) => {
      if (remoteReady && activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify({ type: 'input', data: encodeInput(data) }))
    })
    const connect = (): void => {
      if (closed) return
      const url = new URL('/ws', location.href)
      url.protocol = 'wss:'
      url.searchParams.set('hostId', hostId)
      url.searchParams.set('sessionId', sessionId)
      url.searchParams.set('from', '0') // A new terminal needs the full durable transcript.
      const ws = new WebSocket(url)
      activeSocket = ws
      socket.current = ws
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data as string) as TerminalFrame | { type: 'ready' }
          if (frame.type === 'ready') { remoteReady = true; setReady(true); sendResize(); return }
          if (frame.type === 'output' && frame.data) instance.write(decodeOutput(frame.data))
          if (frame.type === 'state' && frame.info) onInfo(frame.info)
          if (frame.type === 'disconnected') ws.close()
        } catch { /* Ignore corrupt remote frames. */ }
      }
      ws.onclose = () => {
        remoteReady = false
        if (activeSocket === ws) { activeSocket = undefined; socket.current = null }
        setReady(false)
        if (!closed) { instance.clear(); timer = setTimeout(() => { setRetry((value) => value + 1); connect() }, 2500) }
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      observer.disconnect()
      input.dispose()
      activeSocket?.close()
      instance.dispose()
      terminal.current = null
      socket.current = null
    }
  }, [hostId, sessionId])

  function submit(): void {
    if (!ready || !prompt.trim()) return
    terminal.current?.paste(prompt)
    send('\r')
    setPrompt('')
  }

  return <div className="mobile-terminal-wrap">
    <div className="mobile-terminal-status" role="status">{ready ? 'Conectada al mismo proceso remoto' : `Reconectando terminal${retry ? ` · intento ${retry + 1}` : ''}…`}</div>
    <div className="mobile-terminal" ref={surface} />
    <div className="mobile-quickkeys" aria-label="Teclas de terminal">
      {[['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['Enter', '\r']].map(([label, value]) => <button key={label} disabled={!ready} onClick={() => send(value)}>{label}</button>)}
      <button disabled={!ready} onClick={() => terminal.current?.focus()}>Teclado</button>
    </div>
    <div className="mobile-compose"><textarea aria-label="Mensaje al agente" placeholder="Escribí al agente…" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={2} /><button disabled={!ready || !prompt.trim()} onClick={submit}>Enviar</button></div>
  </div>
}

function MobileApp(): React.JSX.Element {
  const [paired, setPaired] = useState(false)
  const [code, setCode] = useState('')
  const [state, setState] = useState<MobileState>({ hosts: [], projects: [] })
  const [hostId, setHostId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionId, setSessionId] = useState('')
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null)
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    try {
      const next = await request<MobileState>('/api/state')
      setPaired(true)
      setState(next)
      setHostId((current) => next.hosts.some((host) => host.id === current) ? current : next.hosts[0]?.id || '')
    } catch (reason) {
      if (String(reason).includes('Emparejamiento')) setPaired(false)
      else setError(String(reason))
    }
  }

  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 7000); return () => clearInterval(timer) }, [])
  useEffect(() => { setProjectId((current) => state.projects.some((project) => project.hostId === hostId && project.id === current) ? current : state.projects.find((project) => project.hostId === hostId)?.id || '') }, [hostId, state.projects])
  useEffect(() => {
    if (!paired || !hostId) return
    const update = async (): Promise<void> => {
      try { setSessions(await request<SessionInfo[]>(`/api/sessions?hostId=${encodeURIComponent(hostId)}`)) }
      catch (reason) { setError(String(reason)) }
    }
    void update()
    const timer = setInterval(() => void update(), 5000)
    return () => clearInterval(timer)
  }, [paired, hostId])

  async function pair(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setError('')
    try { await request<{ ok: boolean }>('/api/pair', 'POST', { code }); setCode(''); await refresh() }
    catch (reason) { setError(String(reason)) }
  }

  async function wake(): Promise<void> {
    if (!sessionInfo) return
    setError('')
    try { setSessionInfo(await request<SessionInfo>('/api/wake', 'POST', { hostId, sessionId: sessionInfo.id })) }
    catch (reason) { setError(String(reason)) }
  }

  const visible = sessions.filter((session) => session.root === state.projects.find((project) => project.id === projectId)?.root)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const selected = sessions.find((session) => session.id === sessionId)
  const currentInfo = sessionInfo?.id === sessionId ? sessionInfo : selected

  if (!paired) return <main className="mobile-pair"><div className="mobile-brand">CROW <span>HARNESS</span></div><h1>Continuá desde el celular</h1><p>Abrí “Acceso móvil” en Crow para obtener el código. Verificá la huella del certificado antes de confiar en esta conexión.</p><form onSubmit={(event) => void pair(event)}><label>Código de emparejamiento<input autoFocus required autoCapitalize="characters" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} /></label><button type="submit">Conectar</button></form>{error && <p className="mobile-error" role="alert">{error}</p>}</main>

  return <div className="mobile-app">
    <header className="mobile-header"><div className="mobile-brand">CROW <span>HARNESS</span></div><small>La app de Windows debe seguir abierta</small></header>
    <nav className="mobile-selectors" aria-label="Seleccionar trabajo"><label>Host<select value={hostId} onChange={(event) => { setHostId(event.target.value); setSessionId(''); setSessionInfo(null) }}>{state.hosts.map((host) => <option key={host.id} value={host.id}>{host.name} · {host.status}</option>)}</select></label><label>Proyecto<select value={projectId} onChange={(event) => { setProjectId(event.target.value); setSessionId(''); setSessionInfo(null) }}>{state.projects.filter((project) => project.hostId === hostId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></nav>
    <div className="mobile-sessions" role="navigation" aria-label="Terminales">{visible.map((session) => <button key={session.id} className={sessionId === session.id ? 'selected' : ''} onClick={() => { setSessionId(session.id); setSessionInfo(session) }}><span>{session.agent} · {session.id.slice(0, 6)}</span><small>{session.state === 'sleeping' ? 'Suspendida' : session.agentState === 'working' ? 'Trabajando' : session.agentState === 'completed' ? 'Completado' : session.state}</small></button>)}{visible.length === 0 && <span className="mobile-empty">No hay terminales en este proyecto.</span>}</div>
    {error && <div className="mobile-error" role="alert" onClick={() => setError('')}>{error}</div>}
    {currentInfo && <div className="mobile-active"><div className="mobile-active-title"><span>{currentInfo.agent} · {currentInfo.id.slice(0, 8)}</span>{currentInfo.state === 'sleeping' && <button onClick={() => void wake()}>Reanudar</button>}</div><TerminalView key={`${hostId}:${currentInfo.id}`} hostId={hostId} sessionId={currentInfo.id} onInfo={setSessionInfo} /></div>}
    {!currentInfo && <div className="mobile-empty mobile-center">Elegí una terminal para retomar la conversación.</div>}
  </div>
}

ReactDOM.createRoot(document.getElementById('mobile-root')!).render(<MobileApp />)
