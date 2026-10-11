import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function harness(status = { running: true, url: 'https://192.168.1.3:1234', devices: [] }, startError = '') {
  const slots = [], effects = [], calls = []
  let cursor = 0
  const react = { useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }, useRef: initial => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] }, useEffect: effect => effects.push(effect) }
  const api = { mobileAddresses: async () => ['192.168.1.3'], mobileStatus: async () => status, mobileStart: async input => { calls.push(['start', input]); if (startError) throw new Error(startError); return { running: true } }, mobileInvite: async input => { calls.push(['invite', input]); return { invitationCode: 'once', expiresAt: '2099-01-01T00:00:00Z', endpoints: [] } } }
  const source = readFileSync(new URL('../src/renderer/src/MobileDialog.tsx', import.meta.url), 'utf8')
  const module = { exports: {} }
  const localRequire = id => id === 'react' ? react : id === 'react/jsx-runtime' ? require(id) : id === 'qrcode' ? { toDataURL: async () => 'data:image/png;base64,mock' } : id === './ConfirmDialog' ? { useConfirm: () => async () => false } : {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, { module, exports: module.exports, require: localRequire, window: { crow: api }, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, Date, URL })
  function render() { cursor = 0; return module.exports.MobileDialog({ projects: [{ id: 'project', name: 'Allowed', hostId: 'host' }], hosts: [{ id: 'host', name: 'Test' }], onClose() {} }) }
  function flatten(value) { if (Array.isArray(value)) return value.flatMap(flatten); if (!value || typeof value !== 'object') return []; return [value, ...flatten(value.props?.children)] }
  return { calls, render, flatten, effects }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('opening mobile settings never automatically starts a network gateway', async () => {
  const h = harness(); h.render(); h.effects[0](); await settle()
  assert.deepEqual(h.calls, [])
})

test('Pangolin setup is explicit, manual and conveys only non-secret configuration', async () => {
  const h = harness({ running: false }); h.render(); h.effects[0](); await settle()
  let nodes = h.flatten(h.render())
  const provider = nodes.find(node => node.type === 'select' && node.props.id === 'mobile-provider')
  assert.equal(provider.props.value, 'tailscale')
  provider.props.onChange({ target: { value: 'pangolin' } })
  nodes = h.flatten(h.render())
  nodes.find(node => node.props.id === 'mobile-origin').props.onChange({ target: { value: 'https://crow.example.com' } })
  nodes.find(node => node.props.id === 'mobile-port').props.onChange({ target: { value: '47323' } })
  nodes = h.flatten(h.render())
  assert.ok(nodes.some(node => node.type === 'label' && node.props.htmlFor === 'mobile-port'))
  assert.match(nodes.map(node => String(node.props.children)).join(' '), /NO instala.*Newt/)
  const button = nodes.find(node => node.type === 'button' && node.props.children === 'Activar gateway')
  button.props.onClick(); button.props.onClick(); await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['start', { address: '192.168.1.3', publicOrigin: 'https://crow.example.com', remoteProvider: 'pangolin', loopbackPort: 47323 }]])
})

test('failed activation has a focusable inline error, without losing the form', async () => {
  const h = harness({ running: false }, 'Puerto ocupado'); h.render(); h.effects[0](); await settle()
  h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Activar gateway').props.onClick(); await settle()
  const nodes = h.flatten(h.render()), error = nodes.find(node => node.props.role === 'alert')
  assert.equal(error.props.tabIndex, -1); assert.match(error.props.children, /Puerto ocupado/)
  assert.ok(nodes.some(node => node.props.id === 'mobile-origin'))
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
