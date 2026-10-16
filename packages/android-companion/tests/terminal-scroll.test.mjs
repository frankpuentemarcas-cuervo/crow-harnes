import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import xterm from '@xterm/xterm'
import { hasScrollableHistory } from '../src/terminal-scroll.mjs'

const { Terminal } = xterm

const view = readFileSync(new URL('../src/TerminalView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('terminal exposes explicit controls to scroll output up and down', () => {
  assert.match(view, /aria-label="Desplazar salida hacia arriba" disabled=\{!hasScrollback\} onClick=\{\(\) => terminal\.current\?\.scrollLines\(-12\)\}/)
  assert.match(view, /aria-label="Desplazar salida hacia abajo" disabled=\{!hasScrollback\} onClick=\{\(\) => terminal\.current\?\.scrollLines\(12\)\}/)
  assert.match(view, /aria-label="Ir al final de la salida" disabled=\{!hasScrollback\}/)
  assert.match(styles, /\.terminal-surface \.xterm-viewport\{touch-action:pan-y;overscroll-behavior:contain\}/)
  assert.match(styles, /\.terminal-scroll/)
})

test('finger scrolling is available for normal xterm history but not for screen-only alternate buffer', async () => {
  const write = (terminal, value) => new Promise(resolve => terminal.write(value, resolve))
  for (const alternate of [false, true]) {
    const terminal = new Terminal({ cols: 80, rows: 8, scrollback: 1000 })
    if (alternate) await write(terminal, '\u001b[?1049h')
    await write(terminal, Array.from({ length: 50 }, (_, index) => `agent line ${index}`).join('\r\n'))
    const before = terminal.buffer.active.viewportY
    const canScroll = hasScrollableHistory(terminal.buffer.active)
    assert.equal(canScroll, !alternate)
    terminal.scrollLines(-12)
    assert.equal(terminal.buffer.active.viewportY < before, !alternate)
    terminal.dispose()
  }
})

test('all terminal action buttons are collapsed together by default', () => {
  assert.match(view, /<details className="terminal-control-panel"><summary aria-label="Mostrar u ocultar controles de terminal">Controles de terminal<\/summary>/)
  assert.ok(view.indexOf('className="terminal-scroll"') > view.indexOf('className="terminal-control-panel"'))
  assert.ok(view.indexOf('className="keys"') > view.indexOf('className="terminal-control-panel"'))
  assert.ok(view.indexOf('className="terminal-actions"') > view.indexOf('className="terminal-control-panel"'))
  assert.match(view, /Esta pantalla interactiva no conserva historial/)
  assert.match(view, /role="region" tabIndex=\{0\} aria-label="Salida de terminal remota"/)
  assert.doesNotMatch(styles, /\.terminal-identity small,\.terminal-actions\{display:none\}/)
})

test('inactive Terminal tab closes its stream and resumes from the retained cursor without recreating xterm', () => {
  assert.match(view, /const cursor = new OutputCursor\(\); let disposed = false, ready = false, blocked = false, active = activeView\.current && appForeground\.current/)
  assert.match(view, /function pause\(\) \{ active = false; clearTimeout\(retryTimer\); retryTimer = undefined; detach\(\); setStreamState\('disconnected'\) \}/)
  assert.match(view, /function resume\(\)[\s\S]*?if \(disposed \|\| blocked \|\| !activeView\.current \|\| !appForeground\.current\)/)
  assert.match(view, /streamControl\.current = control/)
  assert.match(view, /Gateway\.openStream\(\{ profileId: profile\.id, hostId, sessionId: session\.id, from: cursor\.seq, connectionId: id \}\)/)
  assert.match(view, /if \(disposed \|\| !activeView\.current \|\| !appForeground\.current \|\| event\.profileId !== profile\.id/)
  assert.match(view, /appForeground\.current = state\.isActive; if \(state\.isActive && activeView\.current\) resume\(\); else pause\(\)/)
  assert.match(view, /blocked = true; active = false; detach\(\); setStreamState\('disconnected'\)/)
  assert.match(view, /useLayoutEffect\(\(\) => \{\s*if \(!hasActivated\) return\s*if \(isActive && appForeground\.current\) streamControl\.current\?\.resume\(\)\s*else streamControl\.current\?\.pause\(\)\s*\}, \[isActive, hasActivated\]\)/)
  assert.match(view, /instance\.dispose\(\); terminal\.current = null/)
  assert.match(view, /\}, \[hasActivated, profile\.id, hostId, session\.id\]\)/)
})
