import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ConnectionStatus, SessionInfo } from '../../shared/types'
import { terminalClipboardAction } from './terminal-clipboard'
import { decodeOsc52Selection } from './terminal-osc52'
import { PendingTerminalSelection } from './terminal-selection'
import { canFocusTerminal } from './ui-continuity'

function bytes(encoded: string): Uint8Array {
  const raw = atob(encoded)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

export function TerminalPane({ hostId, sessionId, status, active }: { hostId: string; sessionId: string; status: ConnectionStatus; active: boolean }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const fit = useRef<FitAddon | null>(null)
  const subscription = useRef<string>('')
  const lastSeq = useRef(0)
  const lastRemoteSize = useRef('')
  const pendingSelection = useRef(new PendingTerminalSelection())
  const remoteSelection = useRef('')
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [retry, setRetry] = useState(0)
  const [wakeError, setWakeError] = useState('')
  const [clipboardError, setClipboardError] = useState('')
  const [hasSelection, setHasSelection] = useState(false)
  const [hasRemoteSelection, setHasRemoteSelection] = useState(false)

  function clearRemoteSelection(): void {
    remoteSelection.current = ''
    setHasRemoteSelection(false)
  }

  function clearPendingSelection(): void {
    pendingSelection.current.clear()
    setHasSelection(false)
  }

  function clearCopyCandidates(): void {
    if (pendingSelection.current.hasText()) clearPendingSelection()
    if (remoteSelection.current) clearRemoteSelection()
  }

  async function copySelection(): Promise<void> {
    const selected = pendingSelection.current.read(terminal.current?.getSelection() || '') || remoteSelection.current
    if (!selected) return
    try {
      await window.crow.clipboardWriteText(selected)
      terminal.current?.clearSelection()
      clearPendingSelection()
      clearRemoteSelection()
      setClipboardError('')
    } catch (reason) { setClipboardError(`No se pudo copiar: ${String(reason)}`) }
  }

  async function pasteClipboard(): Promise<void> {
    if (!subscription.current) { setClipboardError('La terminal todavía no está conectada.'); return }
    try {
      const text = await window.crow.clipboardReadText()
      if (text && subscription.current) {
        clearCopyCandidates()
        terminal.current?.paste(text)
      }
      setClipboardError('')
    } catch (reason) { setClipboardError(`No se pudo pegar: ${String(reason)}`) }
  }

  async function wake(): Promise<void> {
    setWakeError('')
    try { setInfo(await window.crow.wakeSession(hostId, sessionId)) }
    catch (reason) { setWakeError(String(reason)) }
  }

  async function resizeRemote(id: string, cols: number, rows: number): Promise<void> {
    const size = `${cols}x${rows}`
    if (cols < 1 || rows < 1 || lastRemoteSize.current === size) return
    lastRemoteSize.current = size
    try { await window.crow.terminalResize(id, cols, rows) }
    catch { if (lastRemoteSize.current === size) lastRemoteSize.current = '' }
  }

  useEffect(() => {
    if (!container.current) return
    const instance = new Terminal({
      fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 10000,
      allowTransparency: false,
      theme: { background: '#0a0a0a', foreground: '#fafafa', cursor: '#e5e5e5', selectionBackground: '#404040', black: '#171717', red: '#e27878', green: '#9dc88d', yellow: '#ddc27e', blue: '#8eb7e7', magenta: '#b6a2d9', cyan: '#85c5cc', white: '#fafafa' }
    })
    const addon = new FitAddon()
    instance.loadAddon(addon)
    instance.open(container.current)
    terminal.current = instance
    fit.current = addon
    if (activeRef.current) addon.fit()
    instance.attachCustomKeyEventHandler((event) => {
      const action = terminalClipboardAction(event, instance.hasSelection() || pendingSelection.current.hasText())
      if (!action) return true
      event.preventDefault()
      event.stopPropagation()
      if (action === 'copy') void copySelection()
      else void pasteClipboard()
      return false
    })
    const osc52 = instance.parser.registerOscHandler(52, (data) => {
      const selected = decodeOsc52Selection(data)
      if (selected) {
        remoteSelection.current = selected
        setHasRemoteSelection(true)
      }
      return true
    })
    const selection = instance.onSelectionChange(() => {
      setHasSelection(pendingSelection.current.capture(instance.getSelection()))
    })
    const key = instance.onKey(({ domEvent }) => {
      if (terminalClipboardAction(domEvent, instance.hasSelection() || pendingSelection.current.hasText()) !== 'copy') clearCopyCandidates()
    })
    const input = instance.onData((data) => {
      if (subscription.current) void window.crow.terminalInput(subscription.current, data).catch(() => undefined)
    })
    const resized = instance.onResize(({ cols, rows }) => { if (subscription.current) void resizeRemote(subscription.current, cols, rows) })
    const observer = new ResizeObserver(() => {
      if (activeRef.current && container.current?.clientWidth && container.current?.clientHeight) addon.fit()
    })
    observer.observe(container.current)
    return () => {
      observer.disconnect()
      selection.dispose()
      key.dispose()
      osc52.dispose()
      input.dispose()
      resized.dispose()
      pendingSelection.current.clear()
      instance.dispose()
      terminal.current = null
      fit.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (!active || status !== 'connected' || !terminal.current) return
    let cancelled = false
    let attached = ''
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const attach = async (): Promise<void> => {
      try {
        attached = await window.crow.attach(hostId, sessionId, lastSeq.current, (frame) => {
          if (cancelled) return
          if (frame.type === 'output' && frame.data && frame.seq) {
            if (frame.seq <= lastSeq.current) return
            lastSeq.current = frame.seq
            terminal.current?.write(bytes(frame.data))
          } else if (frame.type === 'state' && frame.info) {
            setInfo(frame.info)
          } else if (frame.type === 'disconnected') {
            subscription.current = ''
            clearTimeout(retryTimer)
            retryTimer = setTimeout(() => { if (!cancelled) setRetry((current) => current + 1) }, 1200)
          }
        })
        if (cancelled) { await window.crow.detach(attached).catch(() => undefined); return }
        subscription.current = attached
        lastRemoteSize.current = ''
        fit.current?.fit()
        if (terminal.current) await resizeRemote(attached, terminal.current.cols, terminal.current.rows)
        if (!cancelled && activeRef.current && container.current && canFocusTerminal(document, container.current)) terminal.current?.focus()
      } catch {
        if (!cancelled) retryTimer = setTimeout(() => { if (!cancelled) setRetry((current) => current + 1) }, 1500)
      }
    }
    void attach()
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      if (attached) void window.crow.detach(attached).catch(() => undefined)
      if (subscription.current === attached) subscription.current = ''
    }
  }, [hostId, sessionId, status, retry, active])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      if (!container.current?.clientWidth || !container.current?.clientHeight) return
      fit.current?.fit()
      if (terminal.current) terminal.current.refresh(0, terminal.current.rows - 1)
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  return <div className="terminal-pane">
    <div className="pane-meta">
      <span className={`session-state ${info?.state || 'running'}`} /> {info?.agent || 'Terminal'}
      <span className="meta-separator">·</span> {sessionId.slice(0, 8)}
      <span className="pane-meta-right">
        {status !== 'connected' ? 'Esperando reconexión' : info?.state === 'exited' ? `Finalizó (${info.exitCode ?? '?'})` : info?.state === 'interrupted' ? 'Interrumpida en el servidor' : info?.state === 'sleeping' ? 'Suspendida · conserva RAM' : info?.agentState === 'working' ? 'Agente trabajando' : info?.agentState === 'completed' ? 'Trabajo completado' : info?.agentState === 'waiting' ? 'Agente esperando' : 'En ejecución'}
      </span>
      <button className="terminal-clipboard-button" disabled={!hasSelection && !hasRemoteSelection} title={hasRemoteSelection && !hasSelection ? 'Copiar texto ofrecido por el agente (Ctrl+Shift+C)' : 'Copiar selección (Ctrl+C o Ctrl+Shift+C)'} onClick={() => void copySelection()}>Copiar</button>
      <button className="terminal-clipboard-button" disabled={status !== 'connected'} title="Pegar (Ctrl+V o Ctrl+Shift+V)" onClick={() => void pasteClipboard()}>Pegar</button>
      {info?.state === 'sleeping' && <button className="terminal-wake" onClick={() => void wake()}>Reanudar</button>}
    </div>
    {wakeError && <div className="inline-error" role="alert">{wakeError}</div>}
    {clipboardError && <div className="inline-error" role="alert">{clipboardError}</div>}
    <div className="terminal-surface" ref={container} onPointerDownCapture={clearCopyCandidates} onPasteCapture={clearCopyCandidates} onCompositionStartCapture={clearCopyCandidates} />
  </div>
}
