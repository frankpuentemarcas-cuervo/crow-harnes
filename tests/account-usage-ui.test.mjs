import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const temp = mkdtempSync(join(tmpdir(), 'crow-quota-render-'))
const transformed = new Map()
function rendererModule(name) {
  const path = resolve('src/renderer/src', name)
  if (transformed.has(path)) return transformed.get(path)
  const dest = join(temp, name.replace(/\.tsx?$/, '.mjs'))
  transformed.set(path, dest)
  let js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  js = js.replace(/^import ['"][^'"]+\.css['"];?$/gm, '')
  js = js.replace(/from (["'])([^"']+)\1/g, (_match, quote, target) => {
    let imported
    if (target.startsWith('.')) {
      const stem = resolve('src/renderer/src', target)
      const extension = extname(stem) || (['Modal', 'ConfirmDialog'].includes(target.slice(2)) ? '.tsx' : '.ts')
      imported = extension === '.tsx' ? rendererModule(target.slice(2) + extension) : stem + (extname(stem) ? '' : extension)
    } else imported = require.resolve(target)
    return `from ${quote}${pathToFileURL(imported).href}${quote}`
  })
  writeFileSync(dest, js)
  return dest
}
const { AccountUsageDock } = await import(pathToFileURL(rendererModule('AccountUsageDock.tsx')).href)
const { AccountUsagePanel } = await import(pathToFileURL(rendererModule('AccountUsagePanel.tsx')).href)
const now = 1_700_000_000_000
const account = { id: 'sample', provider: 'claude', label: 'Trabajo de prueba', status: 'ready', updatedAt: now, windows: [ { id: 'session', label: 'Sesión · 5 h', usedPercent: 0 }, { id: 'week', label: 'Semana', usedPercent: 80, resetsAt: now + 3600000 } ] }
const model = accounts => ({ accounts, loading: false, busy: '', error: '', now, add: async()=>true, login: async()=>true, refresh: async()=>true, remove: async()=>true, clearError(){} })
const dock = (accounts, compact = false, overrides = {}) => renderToStaticMarkup(React.createElement(AccountUsageDock, { model: { ...model(accounts), ...overrides }, compact, onManage(){} }))

test('real dock renders only supplied global accounts and independent quota windows including a true zero', () => {
  const html = dock([account])
  assert.match(html, /Trabajo de prueba/)
  assert.match(html, /Claude Code/)
  assert.match(html, /0% usado/)
  assert.match(html, /80% usado/)
  assert.match(html, /100% disponible/)
  assert.match(html, /20% disponible/)
  assert.match(html, /value="0"/)
  assert.match(html, /value="80"/)
  assert.doesNotMatch(html, /TRABAJO|FACTORY|SSD/)
})

test('empty, error, absent and cached/reset data never masquerade as current zero usage', () => {
  assert.match(dock([]), /Sin cuentas registradas; uso desconocido/)
  const noQuota = dock([{ ...account, windows: [] }])
  assert.match(noQuota, /Uso no disponible · no equivale a 0%/)
  assert.doesNotMatch(noQuota, /<progress/)
  const unknown = dock([{ ...account, windows: [{ id: 'unknown', label: 'Sin muestra', usedPercent: NaN }] }])
  assert.match(unknown, /Sin datos/)
  assert.doesNotMatch(unknown, /<progress/)
  const stale = dock([{ ...account, status: 'error', error: 'Proveedor no disponible', updatedAt: now - 180000, windows: [{ ...account.windows[1], resetsAt: now - 1 }] }])
  assert.match(stale, /lectura anterior/)
  assert.match(stale, /Lectura anterior/)
  assert.match(stale, /Proveedor no disponible/)
  assert.match(dock([], false, { error: 'No se pudo listar' }), /role="alert"/)
})

test('compact fallback and many-account dock retain all account identities/windows without averaging', () => {
  const accounts = Array.from({ length: 30 }, (_, id) => ({ ...account, id: String(id), provider: id % 2 ? 'codex' : 'claude', label: `Cuenta ${id}`, windows: [{ ...account.windows[0], usedPercent: id === 29 ? 100 : 0 }] }))
  const html = dock(accounts, true)
  assert.match(html, /account-usage-dock compact/)
  assert.match(html, /Cuenta 29/)
  assert.match(html, /1 con cuota agotada/)
  assert.equal((html.match(/<article/g) || []).length, 30)
  assert.equal((html.match(/<progress/g) || []).length, 30)
  assert.match(html, /Codex/)
  assert.match(html, /Administrar cuentas y cuotas/)
})

test('actual management panel uses shared snapshot, source attribution, login requirements and accessible modal', () => {
  const html = renderToStaticMarkup(React.createElement(AccountUsagePanel, { model: model([account]), onClose(){} }))
  assert.match(html, /<dialog/)
  assert.match(html, /Claude OAuth · no documentada/)
  assert.match(html, /navegador o la terminal oficial/)
  assert.match(html, /si falta, instalala y reiniciá Crow/)
  assert.match(html, /cada ventana es independiente/)
  assert.match(html, /incluso con este panel cerrado/)
  assert.doesNotMatch(html, /type="password"|accessToken|refreshToken/)
})

process.on('exit', () => rmSync(temp, { recursive: true, force: true }))
