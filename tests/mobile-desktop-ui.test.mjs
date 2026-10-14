import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function harness(status = { running: true, url: 'https://192.168.1.3:1234', devices: [] }, startError = '', statusError = '', confirmation = false, projects = [{ id: 'project', name: 'Allowed', hostId: 'host' }]) {
  const slots = [], effects = [], layouts = [], calls = [], focused = [], confirmations = [], qrCalls = []
  let cursor = 0
  const react = { useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }, useRef: initial => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] }, useEffect: effect => effects.push(effect), useLayoutEffect: (effect, deps) => { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index][i])) layouts.push(effect); slots[index] = deps } }
  const api = { mobileAddresses: async () => ['192.168.1.3'], mobileStatus: async () => { if (statusError) throw new Error(statusError); return status }, mobileStart: async input => { calls.push(['start', input]); if (startError) throw new Error(startError); return { running: true, devices: status.devices } }, mobileStop: async () => { calls.push(['stop']); return { running: false, devices: status.devices } }, mobileRevoke: async id => { calls.push(['revoke', id]); return { ...status, devices: status.devices.filter(device => device.id !== id) } }, mobileInvite: async input => { calls.push(['invite', input]); return { enrollment: { version: 2, gatewayId: 'gateway', invitationCode: 'once', expiresAt: '2099-01-01T00:00:00Z', endpoints: [] }, qrDataUrl: 'data:image/png;base64,mock' } } }
  const source = readFileSync(new URL('../src/renderer/src/MobileDialog.tsx', import.meta.url), 'utf8')
  const module = { exports: {} }
  const localRequire = id => id === 'react' ? react : id === 'react/jsx-runtime' ? require(id) : id === 'qrcode' ? { toDataURL: async value => { qrCalls.push(value); return 'data:image/png;base64,mock' } } : id === './ConfirmDialog' ? { useConfirm: () => async input => { confirmations.push(input); return confirmation } } : {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, { module, exports: module.exports, require: localRequire, window: { crow: api }, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, Date, URL })
  function render() { cursor = 0; return module.exports.MobileDialog({ projects, hosts: [{ id: 'host', name: 'Test' }], onClose() {} }) }
  function flatten(value) { if (Array.isArray(value)) return value.flatMap(flatten); if (!value || typeof value !== 'object') return []; return [value, ...flatten(value.props?.children)] }
  function commit(tree) { for (const node of flatten(tree)) if (node.props.ref) node.props.ref.current = { focus: () => focused.push(node.props.children) }; while (layouts.length) layouts.shift()() }
  return { calls, render, flatten, effects, commit, focused, confirmations, qrCalls }
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
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['start', { address: '192.168.1.3', publicOrigin: 'https://crow.example.com', remoteProvider: 'pangolin', loopbackPort: 47323, relayUrl: '' }]])
})

test('failed activation has a focusable inline error, without losing the form', async () => {
  const h = harness({ running: false }, 'Puerto ocupado'); h.render(); h.effects[0](); await settle()
  h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Activar gateway').props.onClick(); await settle()
  const nodes = h.flatten(h.render()), error = nodes.find(node => node.props.role === 'alert')
  assert.equal(error.props.tabIndex, -1); assert.match(error.props.children, /Puerto ocupado/)
  assert.ok(nodes.some(node => node.props.id === 'mobile-origin'))
})

test('failed submits focus only after commit and refocus identical immediate errors', async () => {
  const h = harness({ running: false }, 'Puerto ocupado'); h.commit(h.render()); h.effects[0](); await settle(); h.commit(h.render())
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tree = h.render(), activate = h.flatten(tree).find(node => node.type === 'button' && node.props.children === 'Activar gateway')
    activate.props.onClick(); activate.props.onClick(); await settle()
    const pending = h.render()
    assert.equal(h.calls.length, attempt, 'busy guard prevents duplicate submission')
    assert.equal(h.focused.length, attempt - 1, 'render/request alone cannot focus an uncommitted alert')
    h.commit(pending)
    assert.equal(h.focused.length, attempt)
    assert.match(h.focused.at(-1), /Puerto ocupado/)
    h.commit(h.render()); assert.equal(h.focused.length, attempt, 'unrelated rerender never steals focus')
  }
})

test('initial status errors do not request focus and no timer races the React commit', async () => {
  const h = harness({ running: false }, '', 'No disponible'); h.commit(h.render()); h.effects[0](); await settle(); h.commit(h.render())
  assert.deepEqual(h.focused, [])
  const source = readFileSync(new URL('../src/renderer/src/MobileDialog.tsx', import.meta.url), 'utf8')
  assert.match(source, /useLayoutEffect\([\s\S]*?errorFocus\.current\?\.focus\(\)[\s\S]*?\[errorFocusRequest\]/)
  assert.doesNotMatch(source, /setTimeout/)
})

test('invitation selects every project by default and keeps write/quotas grants off', async () => {
  const projects = [{ id: 'project', name: 'Allowed', hostId: 'host' }, { id: 'project-2', name: 'Other', hostId: 'host' }]
  const h = harness(undefined, '', '', false, projects); h.render(); h.effects[0](); await settle()
  const nodes = h.flatten(h.render())
  const button = nodes.find(node => node.type === 'button' && node.props.children === 'Generar invitación Android')
  assert.equal(button.props.disabled, false)
  const checkboxes = nodes.filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkboxes.length, 6); assert.ok(checkboxes.slice(0, 2).every(node => node.props.checked)); assert.ok(checkboxes.slice(2).every(node => node.props.checked === false))
  button.props.onClick(); await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['invite', { projectIds: ['project', 'project-2'], capabilities: { input: false, create: false, close: false, quotas: false } }]])
})

test('Pangolin QR requires a resource token, warns about sharing and clears form secrets after generation', async () => {
  const h = harness({ running: true, remoteProvider: 'pangolin', devices: [] }); h.render(); h.effects[0](); await settle()
  let nodes = h.flatten(h.render())
  assert.match(textContent(nodes), /Quien obtenga el QR antes que vos podría vincular/)
  assert.ok(nodes.some(node => node.type === 'input' && node.props.id === 'mobile-pangolin-token-id'))
  const button = () => h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Generar invitación Android')
  assert.equal(button().props.disabled, true)
  nodes.find(node => node.type === 'input' && node.props.id === 'mobile-pangolin-token-id').props.onChange({ target: { value: 'resource-id' } })
  nodes = h.flatten(h.render()); nodes.find(node => node.type === 'input' && node.props.id === 'mobile-pangolin-token').props.onChange({ target: { value: 'resource-token' } })
  assert.equal(button().props.disabled, false)
  button().props.onClick(); await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), ['invite', { projectIds: ['project'], capabilities: { input: false, create: false, close: false, quotas: false }, pangolinAuth: { tokenId: 'resource-id', token: 'resource-token' } }])
  assert.ok(h.flatten(h.render()).some(node => node.type === 'img' && node.props.src === 'data:image/png;base64,mock'))
  assert.ok(!h.flatten(h.render()).some(node => node.type === 'textarea'))
})

const linkedDevice = { id: 'phone', label: 'Mi Android', expiresAt: '2099-01-01T00:00:00Z', projectIds: ['project'], capabilities: { input: false, quotas: false } }
const textContent = nodes => nodes.map(node => String(node.props.children)).join(' ')

test('pausing disconnects access, keeps the linked device visible and explains encrypted trust with unchanged expiry', async () => {
  const h = harness({ running: true, devices: [linkedDevice] }, '', '', true)
  h.render(); h.effects[0](); await settle()
  h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Pausar acceso').props.onClick(); await settle()
  assert.deepEqual(h.calls, [['stop']])
  assert.match(h.confirmations[0].message, /desconecta.*conserva.*hasta revocación.*vencimiento/i)
  assert.doesNotMatch(h.confirmations[0].message, /en memoria/)
  assert.equal(h.confirmations[0].danger, false)
  const nodes = h.flatten(h.render()), text = textContent(nodes)
  assert.match(text, /Mi Android/)
  assert.match(text, /12 horas/)
  assert.match(text, /guardan cifrados.*conservan al reiniciar/)
  assert.match(text, /vínculos antiguos conservan su vencimiento de 12 horas/)
  assert.match(text, /credenciales de acceso vencen a los 15 minutos/)
  assert.match(text, /cambia la IP.*nueva invitación LAN/)
  assert.doesNotMatch(text, /solo en memoria|cerrar o reiniciar.*vincular.*otra vez/)
  assert.doesNotMatch(text, /detenido.*vinculá el teléfono otra vez/i)
  assert.ok(nodes.some(node => node.type === 'button' && node.props.children === 'Reanudar acceso'))
  assert.ok(nodes.some(node => node.type === 'button' && node.props.children === 'Revocar dispositivo'))
  nodes.find(node => node.type === 'button' && node.props.children === 'Reanudar acceso').props.onClick(); await settle()
  assert.equal(h.calls[1][0], 'start')
  assert.ok(h.flatten(h.render()).some(node => node.props.children === 'Mi Android'))
  assert.match(textContent(h.flatten(h.render())), /vínculo vigente pueden reconectarse/)
})

test('key-based trust displays revocation rather than a fictitious expiry and preserves legacy dates', async () => {
  const keyDevice = { ...linkedDevice, id: 'key-phone', label: 'Android protegido', expiresAt: null }
  const h = harness({ running: false, devices: [keyDevice, linkedDevice] })
  h.render(); h.effects[0](); await settle()
  const text = textContent(h.flatten(h.render()))
  assert.match(text, /Confianza hasta revocación/)
  assert.match(text, /Vínculo antiguo · vence/)
  assert.match(text, /nueva invitación para migrar/)
  assert.doesNotMatch(text, /1970|Invalid Date|NaN/)
})

test('cancelled pause leaves the gateway and device untouched', async () => {
  const h = harness({ running: true, devices: [linkedDevice] })
  h.render(); h.effects[0](); await settle()
  h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Pausar acceso').props.onClick(); await settle()
  assert.deepEqual(h.calls, [])
  assert.ok(h.flatten(h.render()).some(node => node.props.children === 'Mi Android'))
})

test('a paused gateway never generates or presents an invitation QR even with retained enrollment', async () => {
  const h = harness({ running: false, devices: [linkedDevice], enrollment: { invitationCode: 'old', expiresAt: '2099-01-01T00:00:00Z', endpoints: [] } })
  h.render(); h.effects[0](); await settle()
  h.render(); h.effects.at(-1)(); await settle()
  const nodes = h.flatten(h.render())
  assert.deepEqual(h.qrCalls, [])
  assert.ok(!nodes.some(node => node.type === 'img' || node.props['aria-label'] === 'Invitación Android JSON'))
})

test('revocation while paused is explicit and requires confirmation', async () => {
  for (const confirmation of [false, true]) {
    const h = harness({ running: false, devices: [linkedDevice] }, '', '', confirmation)
    h.render(); h.effects[0](); await settle()
    h.flatten(h.render()).find(node => node.type === 'button' && node.props.children === 'Revocar dispositivo').props.onClick(); await settle()
    assert.equal(h.confirmations[0].danger, true)
    assert.match(h.confirmations[0].message, /vincularse otra vez/)
    assert.deepEqual(h.calls, confirmation ? [['revoke', 'phone']] : [])
    assert.equal(h.flatten(h.render()).some(node => node.props.children === 'Mi Android'), !confirmation)
  }
})
