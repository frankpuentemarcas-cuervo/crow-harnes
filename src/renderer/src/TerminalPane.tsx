import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ConnectionStatus, SessionInfo } from '../../shared/types'

function bytes(encoded: string): Uint8Array {
  const raw = atob(encoded)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

export function TerminalPane({ hostId, sessionId, status }: { hostId: string; sessionId: string; status: ConnectionStatus }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const subscription = useRef<string>('')
  const lastSeq = useRef(0)
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [retry, setRetry] = useState(0)

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
    addon.fit()
    const input = instance.onData((data) => { if (subscription.current) void window.crow.terminalInput(subscription.current, data).catch(() => undefined) })
    const resized = instance.onResize(({ cols, rows }) => { if (subscription.current) void window.crow.terminalResize(subscription.current, cols, rows).catch(() => undefined) })
    const observer = new ResizeObserver(() => { addon.fit() })
    observer.observe(container.current)
    return () => {
      observer.disconnect()
      input.dispose()
      resized.dispose()
      instance.dispose()
      terminal.current = null
      fit.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (status !== 'connected' || !terminal.current) return
    let cancelled = false
    let attached = ''
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
            setTimeout(() => { if (!cancelled) setRetry((current) => current + 1) }, 1200)
          }
        })
        if (cancelled) { await window.crow.detach(attached).catch(() => undefined); return }
        subscription.current = attached
        fit.current?.fit()
        if (terminal.current) await window.crow.terminalResize(attached, terminal.current.cols, terminal.current.rows)
        terminal.current?.focus()
      } catch {
        if (!cancelled) setTimeout(() => setRetry((current) => current + 1), 1500)
      }
    }
    void attach()
    return () => {
      cancelled = true
      if (attached) void window.crow.detach(attached).catch(() => undefined)
      if (subscription.current === attached) subscription.current = ''
    }
  }, [hostId, sessionId, status, retry])

  return <div className="terminal-pane"><div className="pane-meta"><span className={`session-state ${info?.state || 'running'}`} /> {info?.agent || 'Terminal'} <span className="meta-separator">·</span> {sessionId.slice(0, 8)} <span className="pane-meta-right">{status !== 'connected' ? 'Esperando reconexión' : info?.state === 'exited' ? `Finalizó (${info.exitCode ?? '?'})` : info?.state === 'interrupted' ? 'Interrumpida en el servidor' : 'En ejecución'}</span></div><div className="terminal-surface" ref={container} /></div>
}
