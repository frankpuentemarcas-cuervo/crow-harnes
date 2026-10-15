import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { encodeInput, inputByteLength, MAX_INPUT_BYTES } from '../src/protocol.mjs'

const source = readFileSync(new URL('../src/TerminalView.tsx', import.meta.url), 'utf8')
function actions(send = async () => {}) {
  const calls = [], errors = [], notices = [], pending = [], connection = { current: 'stream' }, live = { current: true }
  let recoveries = 0, fits = 0
  const context = { encodeInput, inputByteLength, MAX_INPUT_BYTES, connection, live, writable: { current: true },
    Gateway: { send: async body => { calls.push(body); return send(body) } },
    onError: text => errors.push(text), retryConnection: { current: () => { recoveries++; live.current = false } },
    terminal: { current: { cols: 80, rows: 24 } }, fit: { current: { fit() { fits++ } } }, connected: true, resizing: false,
    setResizing: value => pending.push(value), setResizeMessage: text => notices.push(text), String }
  const methods = source.slice(source.indexOf('  async function send('), source.indexOf('  useEffect(() => {')) + '\n' + source.slice(source.indexOf('  async function resizeRemote('), source.indexOf('  return <section'))
  const compiled = ts.transpileModule(methods + '\nglobalThis.actions = { send, resizeRemote };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(compiled, context)
  return { ...context.actions, calls, errors, notices, pending, connection, live, recoveries: () => recoveries, fits: () => fits }
}

test('terminal sends UTF-8 once and reconnects reading after failure without replaying input', async () => {
  const success = actions()
  assert.equal(await success.send('Hola ñ\r'), true)
  assert.equal(success.calls.length, 1)
  assert.equal(success.calls[0].data, encodeInput('Hola ñ\r'))
  const failed = actions(async () => { throw new Error('Falló el transporte') })
  assert.equal(await failed.send('Mensaje\r'), false)
  assert.equal(failed.calls.length, 1)
  assert.equal(failed.recoveries(), 1)
  assert.match(failed.errors[0], /Verificá el resultado/)
})

test('resize shows the native cause and reconnects without retrying the resize', async () => {
  const failed = actions(async () => { throw new Error('HTTP 409') })
  await failed.resizeRemote()
  assert.equal(failed.calls.length, 1)
  assert.equal(failed.calls[0].type, 'resize')
  assert.equal(failed.fits(), 1)
  assert.match(failed.errors[0], /HTTP 409/)
  assert.equal(failed.recoveries(), 1)
  assert.deepEqual(failed.pending, [true, false])
  assert.deepEqual(failed.notices, [])
})

test('late input failure cannot reconnect or show errors over another terminal', async () => {
  let reject
  const failed = actions(() => new Promise((_, deny) => { reject = deny }))
  const pending = failed.send('Mensaje\r')
  failed.connection.current = 'new-stream'
  reject(new Error('Old failure'))
  assert.equal(await pending, false)
  assert.equal(failed.recoveries(), 0)
  assert.deepEqual(failed.errors, [])
})

test('successful resize reports completion only for its current connection', async () => {
  const success = actions()
  await success.resizeRemote()
  assert.equal(success.notices.length, 1)
  assert.equal(success.recoveries(), 0)
  assert.deepEqual(success.pending, [true, false])
})
