import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const terminal = readFileSync(new URL('../src/TerminalView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('server selection is shared between home and projects instead of buried on projects', () => {
  assert.match(app, /profile && bootstrap && <section className="host-picker"/)
  assert.ok(app.indexOf('className="host-picker"') < app.indexOf("page === 'Inicio'"))
  assert.match(app, /Sin conexión · reintentando automáticamente/)
})

test('terminal output keeps space by collapsing secondary tools and keeping composer last', () => {
  assert.match(terminal, /<details className="terminal-actions"><summary>Más acciones de terminal<\/summary>/)
  assert.ok(terminal.indexOf('className="terminal-actions"') < terminal.indexOf('className="compose"'))
  assert.match(styles, /@media\(max-height:560px\)/)
  assert.match(styles, /\.terminal-scroll button\{min-height:48px/)
})

test('errors can be dismissed without concealing connection status', () => {
  assert.match(app, /className="error" role="alert"/)
  assert.match(app, /aria-label="Descartar aviso"/)
  assert.match(app, /connection-\$\{status\}/)
})

test('device authentication rejection leaves connecting state without retrying actions', () => {
  assert.match(app, /revocado\|vencido\|forgotten\|rechazó la autenticación del dispositivo\|HTTP 401/)
  assert.match(app, /setStatus\('revoked'\); setBootstrap\(null\)/)
  assert.match(app, /Acceso rechazado o vencido · revisá el vínculo/)
})
