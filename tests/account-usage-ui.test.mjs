import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panel = readFileSync(new URL('../src/renderer/src/AccountUsagePanel.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')

test('accounts are exposed globally, with no host argument in preload', () => {
  assert.match(app, /<AccountUsagePanel onClose=/)
  assert.match(app, />Cuentas<\/button>/)
  for (const method of ['List', 'Add', 'Login', 'Refresh', 'Remove']) assert.match(preload, new RegExp(`accounts${method}:`))
  assert.match(preload, /accountsLogin: \(id\) => ipcRenderer.invoke\('crow:accounts-login', id\)/)
})

test('quota panel protects absent/stale data and bounded refresh lifecycle', () => {
  assert.match(panel, /Uso no disponible\. No equivale a 0 % de consumo/)
  assert.match(panel, /datos anteriores/)
  assert.match(panel, /180_000/)
  assert.match(panel, /clearInterval\(timer\)/)
  assert.match(panel, /operation.current\) return/)
  assert.match(panel, /document.visibilityState === 'hidden'/)
  assert.match(panel, /account.retryAt > Date.now\(\)/)
  assert.match(panel, /await refreshAccounts\(result\)/)
  assert.match(panel, /Promise.resolve\(\).then\(async \(\) => \{\s+if \(stopped\) return/)
  assert.match(panel, /if \(!stopped\) update\(refreshed\)/)
})

test('quota cards show independent remaining quota, provider source and actionable login requirements', () => {
  assert.match(panel, /100 - window.usedPercent/)
  assert.match(panel, /cada ventana es independiente/)
  assert.match(panel, /Codex app-server/)
  assert.match(panel, /Claude OAuth · no documentada/)
  assert.match(panel, /navegador o la terminal oficial/)
  assert.match(panel, /si falta, instalala y reiniciá Crow/)
})

test('account removal requires confirmation and shared accessible modal', () => {
  assert.match(panel, /await confirm\(/)
  assert.match(panel, /<Modal titleId="accounts-title"/)
  assert.match(panel, /role="alert"/)
  assert.doesNotMatch(panel, /window\.(?:confirm|prompt|alert)\(/)
  assert.doesNotMatch(panel, /type="password"|accessToken|refreshToken/)
})
