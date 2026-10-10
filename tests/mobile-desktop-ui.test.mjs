import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function harness() {
  const slots = [], effects = [], calls = []
  let cursor = 0
  const react = { useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }, useRef: initial => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] }, useEffect: effect => effects.push(effect) }
  const api = { mobileAddresses: async () => ['192.168.1.3'], mobileStatus: async () => ({ running: true, url: 'https://192.168.1.3:1234', devices: [] }), mobileStart: async input => { calls.push(['start', input]); return { running: true } }, mobileInvite: async input => { calls.push(['invite', input]); return { invitationCode: 'once', expiresAt: '2099-01-01T00:00:00Z', endpoints: [] } } }
  const source = readFileSync(new URL('../src/renderer/src/MobileDialog.tsx', import.meta.url), 'utf8')
  const module = { exports: {} }
  const localRequire = id => id === 'react' ? react : id === 'react/jsx-runtime' ? require(id) : id === 'qrcode' ? { toDataURL: async () => 'data:image/png;base64,mock' } : id === './ConfirmDialog' ? { useConfirm: () => async () => false } : {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, { module, exports: module.exports, require: localRequire, window: { crow: api }, setInterval: () => 0, clearInterval() {}, Date })
  function render() { cursor = 0; return module.exports.MobileDialog({ projects: [{ id: 'project', name: 'Allowed', hostId: 'host' }], hosts: [{ id: 'host', name: 'Test' }], onClose() {} }) }
  function flatten(value) { if (Array.isArray(value)) return value.flatMap(flatten); if (!value || typeof value !== 'object') return []; return [value, ...flatten(value.props?.children)] }
  return { calls, render, flatten, effects }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('opening mobile settings never automatically starts a network gateway', async () => {
  const h = harness(); h.render(); h.effects[0](); await settle()
  assert.deepEqual(h.calls, [])
})

test('invitation requires explicit project selection and defaults all write/quotas grants off', async () => {
  const h = harness(); h.render(); h.effects[0](); await settle()
  let nodes = h.flatten(h.render())
  let button = nodes.find(node => node.type === 'button' && node.props.children === 'Generar invitación Android')
  assert.equal(button.props.disabled, true)
  const checkboxes = nodes.filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkboxes.length, 5); assert.ok(checkboxes.every(node => node.props.checked === false))
  checkboxes[0].props.onChange({ target: { checked: true } })
  nodes = h.flatten(h.render()); button = nodes.find(node => node.type === 'button' && node.props.children === 'Generar invitación Android')
  assert.equal(button.props.disabled, false)
  button.props.onClick(); await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['invite', { projectIds: ['project'], capabilities: { input: false, create: false, close: false, quotas: false } }]])
})
