import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { FitAddon } from '@xterm/addon-fit'
import type { ConnectionStatus, SessionInfo, TerminalCheckpointLoadResult } from '../../shared/types'
import { terminalClipboardAction, copyTerminalClipboardEvent, pasteTerminalClipboardEvent } from './terminal-clipboard'
import { decodeOsc52Selection } from './terminal-osc52'
import { PendingTerminalSelection } from './terminal-selection'
import { canFocusTerminal } from './ui-continuity'

function bytes(encoded: string): Uint8Array {
  const raw = atob(encoded)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

export function TerminalPane({ hostId, sessionId, status, active, readOnly = false }: { hostId: string; sessionId: string; status: ConnectionStatus; active: boolean; readOnly?: boolean }): React.JSX.Element {
  const readonlyRef = useRef(readOnly)
  readonlyRef.current = readOnly
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const serializer = useRef<SerializeAddon | null>(null)
  const restoreCheckpoint = useRef<Promise<void>>(Promise.resolve())
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restoring = useRef(true)
  const fallbackAnnounced = useRef(false)
  const savedViewportY = useRef<number | undefined>(undefined)
  const loadResult = useRef<TerminalCheckpointLoadResult['status']>('missing')
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
  const [checkpointNotice, setCheckpointNotice] = useState('')
  const [hasSelection, setHasSelection] = useState(false)
  const [hasRemoteSelection, setHasRemoteSelection] = useState(false)

  async function persistCheckpoint(): Promise<void> {
    const addon = serializer.current, instance = terminal.current, seq = lastSeq.current
    if (!addon || !instance || seq <= 0) return
    try {
      const result = await window.crow.saveTerminalCheckpoint(hostId, sessionId, { seq, state: addon.serialize({ scrollback: 10000 }), viewportY: instance.buffer.active.viewportY })
      if (terminal.current !== instance) return
      if (result !== 'saved') showCheckpointNotice(result === 'oversized' ? 'El snapshot supera 32 MB sin comprimir o 8 MB comprimido; se conserva el anterior y se avisará si hay que cargar el historial remoto.' : 'No se pudo guardar el snapshot local; al reabrir se cargará el historial remoto.')
    } catch { if (terminal.current === instance) showCheckpointNotice('No se pudo guardar el snapshot local; al reabrir se cargará el historial remoto.') }
  }

  function showCheckpointNotice(message: string, duration = 9000): void {
    setCheckpointNotice(message)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = duration > 0 ? setTimeout(() => setCheckpointNotice(''), duration) : undefined
  }

  function checkpointFallbackMessage(status: TerminalCheckpointLoadResult['status'], complete = false): string {
    const cause = status === 'missing' ? 'no hay checkpoint local' : status === 'oversized' ? 'el checkpoint supera el límite' : status === 'unavailable' ? 'el cifrado local no está disponible' : 'el checkpoint no se pudo leer'
    return complete ? `Historial remoto recuperado; ${cause}.` : `Aviso: ${cause}; se cargará el historial remoto desde el inicio.`
  }

  function scheduleCheckpoint(delay = 2500): void {
    clearTimeout(checkpointTimer.current)
    checkpointTimer.current = setTimeout(() => { void persistCheckpoint() }, delay)
  }

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

  function selectedText(): string {
    return pendingSelection.current.read(terminal.current?.getSelection() || '') || remoteSelection.current
  }

  function copied(): void {
    terminal.current?.clearSelection()
    clearPendingSelection()
    clearRemoteSelection()
    setClipboardError('')
  }

  async function copySelection(): Promise<void> {
    const selected = selectedText()
    if (!selected) return
    try {
      await window.crow.clipboardWriteText(selected)
      // A new selection made while the clipboard IPC was pending must survive.
      if (selectedText() === selected) copied()
    } catch (reason) { setClipboardError(`No se pudo copiar: ${String(reason)}`) }
  }

  async function pasteClipboard(): Promise<void> {
    if (readonlyRef.current) return
    if (!subscription.current) { setClipboardError('La terminal todavía no está conectada.'); return }
    const stream = subscription.current
    const instance = terminal.current
    try {
      const text = await window.crow.clipboardReadText()
      if (!activeRef.current || subscription.current !== stream || terminal.current !== instance) return
      if (text) {
        clearCopyCandidates()
        instance?.paste(text)
      }
      setClipboardError('')
    } catch (reason) { setClipboardError(`No se pudo pegar: ${String(reason)}`) }
  }

  async function wake(): Promise<void> {
    if (readonlyRef.current) return
    setWakeError('')
    try { setInfo(await window.crow.wakeSession(hostId, sessionId)) }
    catch (reason) { setWakeError(String(reason)) }
  }

  async function resizeRemote(id: string, cols: number, rows: number): Promise<void> {
    if (readonlyRef.current) return
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
      fontSize: 16,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 10000,
      allowTransparency: false,
      theme: { background: '#0a0a0a', foreground: '#fafafa', cursor: '#e5e5e5', selectionBackground: '#404040', black: '#171717', red: '#e27878', green: '#9dc88d', yellow: '#ddc27e', blue: '#8eb7e7', magenta: '#b6a2d9', cyan: '#85c5cc', white: '#fafafa' }
    })
    const addon = new FitAddon()
    instance.loadAddon(addon)
    const serializerAddon = new SerializeAddon()
    instance.loadAddon(serializerAddon)
    instance.open(container.current)
    terminal.current = instance
    serializer.current = serializerAddon
    fit.current = addon
    if (activeRef.current) addon.fit()
    restoring.current = true
    restoreCheckpoint.current = window.crow.loadTerminalCheckpoint(hostId, sessionId).then(result => {
      if (terminal.current !== instance) return
      loadResult.current = result.status
      if (result.status !== 'restored') return
      const checkpoint = result.checkpoint
      savedViewportY.current = checkpoint.viewportY
      if (!checkpoint.seq || !checkpoint.state) return
      return new Promise<void>(resolve => instance.write(checkpoint.state, () => { if (terminal.current === instance) lastSeq.current = checkpoint.seq; resolve() }))
    }).catch(() => { loadResult.current = 'invalid' })
    instance.attachCustomKeyEventHandler((event) => {
      const action = terminalClipboardAction(event, Boolean(selectedText()))
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
    const scrolled = instance.onScroll(() => { if (!restoring.current) scheduleCheckpoint(700) })
    const key = instance.onKey(({ domEvent }) => {
      if (terminalClipboardAction(domEvent, Boolean(selectedText())) !== 'copy') clearCopyCandidates()
    })
    const input = instance.onData((data) => {
      if (subscription.current && !readonlyRef.current) void window.crow.terminalInput(subscription.current, data).catch(() => undefined)
    })
    const resized = instance.onResize(({ cols, rows }) => { if (subscription.current) void resizeRemote(subscription.current, cols, rows) })
    const observer = new ResizeObserver(() => {
      if (activeRef.current && container.current?.clientWidth && container.current?.clientHeight) addon.fit()
    })
    observer.observe(container.current)
    return () => {
      observer.disconnect()
      selection.dispose()
      scrolled.dispose()
      key.dispose()
      osc52.dispose()
      input.dispose()
      resized.dispose()
      pendingSelection.current.clear()
      clearTimeout(checkpointTimer.current)
      clearTimeout(noticeTimer.current)
      void persistCheckpoint()
      serializerAddon.dispose()
      instance.dispose()
      terminal.current = null
      serializer.current = null
      fit.current = null
    }
  }, [hostId, sessionId])

  useEffect(() => {
    if (!active || status !== 'connected' || !terminal.current) return
    let cancelled = false
    let attached = ''
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let pendingWrites = 0
    let replayStateReceived = false
    let replayedOutput = false
    let viewportRestored = false
    const finishReplay = (): void => {
      if (!replayStateReceived || pendingWrites > 0 || viewportRestored) return
      viewportRestored = true
      const instance = terminal.current
      const savedLine = savedViewportY.current
      let notice = ''
      if (savedLine !== undefined && instance) {
        const availableLine = instance.buffer.active.baseY
        if (savedLine > availableLine) notice = 'La posición guardada ya no está disponible en el scrollback actual.'
        instance.scrollToLine(Math.min(savedLine, availableLine))
      } else if (loadResult.current !== 'restored' && replayedOutput) notice = checkpointFallbackMessage(loadResult.current, true)
      else if (loadResult.current === 'restored' && savedLine === undefined) notice = 'Snapshot restaurado; esta copia no guardaba la posición de lectura.'
      restoring.current = false
      if (notice) showCheckpointNotice(notice)
      else if (loadResult.current !== 'restored') { clearTimeout(noticeTimer.current); setCheckpointNotice('') }
    }
    const attach = async (): Promise<void> => {
      try {
        await restoreCheckpoint.current
        if (cancelled) return
        if (loadResult.current !== 'restored' && !fallbackAnnounced.current) {
          fallbackAnnounced.current = true
          showCheckpointNotice(checkpointFallbackMessage(loadResult.current), 0)
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          if (cancelled) return
        }
        attached = await window.crow.attach(hostId, sessionId, lastSeq.current, (frame) => {
          if (cancelled) return
          if (frame.type === 'output' && frame.data && frame.seq) {
            if (frame.seq <= lastSeq.current) return
            replayedOutput = true
            lastSeq.current = frame.seq
            pendingWrites++
            terminal.current?.write(bytes(frame.data), () => { pendingWrites--; scheduleCheckpoint(); finishReplay() })
          } else if (frame.type === 'state' && frame.info) {
            setInfo(frame.info)
            replayStateReceived = true
            finishReplay()
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
      <button className="terminal-clipboard-button" disabled={!hasSelection && !hasRemoteSelection} title="Copiar selección (Ctrl+C o Ctrl+Shift+C)" onClick={() => void copySelection()}>Copiar</button>
      <button className="terminal-clipboard-button" disabled={status !== 'connected' || readOnly} title="Pegar (Ctrl+V o Ctrl+Shift+V)" onClick={() => void pasteClipboard()}>Pegar</button>
      {readOnly && <span>· Sólo lectura</span>}
      {info?.state === 'sleeping' && !readOnly && <button className="terminal-wake" onClick={() => void wake()}>Reanudar</button>}
    </div>
    {wakeError && <div className="inline-error" role="alert">{wakeError}</div>}
    {clipboardError && <div className="inline-error" role="alert">{clipboardError}</div>}
    {checkpointNotice && <div className="inline-error" role="status">{checkpointNotice}</div>}
    <div className="terminal-surface" ref={container} onPointerDownCapture={clearCopyCandidates} onCompositionStartCapture={clearCopyCandidates}
      onPointerUpCapture={() => setHasSelection(pendingSelection.current.capture(terminal.current?.getSelection() || ''))}
      onCopyCapture={(event) => {
        try { if (copyTerminalClipboardEvent(event, selectedText())) copied() }
        catch (reason) { event.preventDefault(); event.stopPropagation(); setClipboardError(`No se pudo copiar: ${String(reason)}`) }
      }}
      onPasteCapture={(event) => {
        if (readonlyRef.current || !subscription.current || !activeRef.current) {
          event.preventDefault(); event.stopPropagation()
          setClipboardError('La terminal todavía no está conectada.')
          return
        }
        pasteTerminalClipboardEvent(event, (text) => {
          clearCopyCandidates()
          terminal.current?.paste(text)
        })
        setClipboardError('')
      }} />
  </div>
}
