import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('../src/TerminalView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('terminal exposes explicit controls to scroll output up and down', () => {
  assert.match(view, /aria-label="Desplazar salida hacia arriba"[^>]*onClick=\{\(\) => terminal\.current\?\.scrollLines\(-12\)\}/)
  assert.match(view, /aria-label="Desplazar salida hacia abajo"[^>]*onClick=\{\(\) => terminal\.current\?\.scrollLines\(12\)\}/)
  assert.match(view, /scrollToBottom\(\)/)
  assert.match(styles, /\.terminal-scroll/)
})
