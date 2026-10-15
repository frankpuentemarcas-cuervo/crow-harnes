import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function harness(status = { running: false, devices: [] }, confirmation = false, skippedHosts = []) {
  const slots = [], effects = [], calls = [], confirmations = []
  let cursor = 0
  const react = {
    useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] },
    useRef: initial => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect: effect => effects.push(effect),
  }
  const api = {
    mobileStatus: async () => status,
    mobileInvite: async input => { calls.push(['invite', input]); return { enrollment: { expiresAt: '2099-01-01T00:00:00Z' }, hostCount: 2, skippedHosts, qrDataUrl: 'data:image/png;base64,mock' } },
    mobileRevoke: async id => { calls.push(['revoke', id]); return { ...status, devices: [] } },
  }
  const source = readFileSync(new URL('../src/renderer/src/MobileDialog.tsx', import.meta.url), 'utf8')
  const module = { exports: {} }
  const localRequire = id => id === 'react' ? react : id === 'react/jsx-runtime' ? require(id) : id === './ConfirmDialog' ? { useConfirm: () => async input => { confirmations.push(input); return confirmation } } : {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, { module, exports: module.exports, require: localRequire, window: { crow: api }, setInterval: () => 0, clearInterval() {}, Date })
  const projects = [{ id: 'project', hostId: 'host', name: 'One' }, { id: 'second', hostId: 'host', name: 'Two' }]
  function render() { cursor = 0; return module.exports.MobileDialog({ projects, hosts: [{ id: 'host', name: 'SSD' }], onClose() {} }) }
  function flatten(value) { if (Array.isArray(value)) return value.flatMap(flatten); if (!value || typeof value !== 'object') return []; return [value, ...flatten(value.props?.children)] }
  return { render, flatten, calls, effects, confirmations }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('mobile dialog provisions all selected projects from one button without manual network secrets', async () => {
  const h = harness(); h.render(); h.effects[0](); await settle()
  const nodes = h.flatten(h.render())
  assert.equal(h.calls.length, 0, 'opening does not expose a gateway')
  assert.equal(nodes.filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 3)
  assert.equal(nodes.some(node => ['mobile-provider', 'mobile-port', 'mobile-pangolin-token'].includes(node.props.id)), false)
  nodes.find(node => node.type === 'button' && node.props.children === 'Generar QR para Android').props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['invite', { projectIds: ['project', 'second'], capabilities: { input: true, create: true, close: false, quotas: false } }]])
  assert.ok(h.flatten(h.render()).some(node => node.type === 'img' && node.props.src === 'data:image/png;base64,mock'))
})

test('quota access is opt-in and is included only after explicit consent', async () => {
  const h = harness(); h.render()
  const checkboxes = h.flatten(h.render()).filter(node => node.type === 'input' && node.props.type === 'checkbox')
  const quota = checkboxes.at(-1)
  assert.equal(quota.props.checked, false)
  quota.props.onChange({ target: { checked: true } })
  h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Generar QR para Android').props.onClick()
  await settle()
  assert.equal(h.calls[0][1].capabilities.quotas, true)
})

test('revocation is explicit and confirmed', async () => {
  const device = { id: 'phone', label: 'Mi Android', expiresAt: null }
  const h = harness({ running: true, devices: [device] }, true); h.render(); h.effects[0](); await settle()
  h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Revocar').props.onClick()
  await settle()
  assert.equal(h.confirmations[0].danger, true)
  assert.deepEqual(h.calls, [['revoke', 'phone']])
})

test('QR dialog explains when a selected host was excluded', async () => {
  const h = harness(undefined, false, [{ name: 'FACTORY', reason: 'sin conexión' }]); h.render()
  h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Generar QR para Android').props.onClick()
  await settle()
  const status = h.flatten(h.render()).find(node => node.props.role === 'status' && JSON.stringify(node.props.children).includes('FACTORY'))
  assert.ok(status)
  assert.match(JSON.stringify(status.props.children), /sin conexión/)
})
