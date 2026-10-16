import test from 'node:test'
import assert from 'node:assert/strict'
import { boundedRead, fallbackProfile, sessionProfile, revokedConnection, retryableConnection } from '../src/connection-read.mjs'

test('deadline stops a hung read exactly once and ignores its late completion', async () => {
  let complete, started = 0, cancelled = 0
  const result = boundedRead(() => { started++; return new Promise(resolve => { complete = resolve }) }, () => { cancelled++ }, undefined, 10)
  await assert.rejects(result, /15 segundos/)
  complete('late'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, 1); assert.equal(cancelled, 1)
})
test('profile/lifecycle cancellation does not start stale work or leave a timer alive', async () => {
  const controller = new AbortController(); controller.abort()
  let started = 0, cancelled = 0
  await assert.rejects(boundedRead(() => started++, () => cancelled++, controller.signal, 10), /Lectura cancelada/)
  assert.equal(started, 0); assert.equal(cancelled, 0)
  const active = new AbortController()
  const result = boundedRead(() => new Promise(() => {}), () => { cancelled++ }, active.signal, 10)
  active.abort(); await assert.rejects(result, /Lectura cancelada/)
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(cancelled, 1)
})
test('successful reads and immediate errors are settled without cancellation or automatic retry', async () => {
  let cancelled = 0, calls = 0
  assert.equal(await boundedRead(() => 42, () => cancelled++, undefined, 10), 42)
  await assert.rejects(boundedRead(() => { calls++; throw new Error('HTTP 403') }, () => cancelled++, undefined, 10), /HTTP 403/)
  assert.equal(cancelled, 0); assert.equal(calls, 1)
})
const profile = (id, host, projectIds = ['p']) => ({ id, mobileHostId: host, device: { projectIds } })
test('explicit selected host always wins; routing cannot pick a duplicate or unrelated identity', () => {
  const windows = profile('w', 'windows'), first = profile('old', 'factory'), selected = profile('new', 'factory'), unrelated = profile('other', 'ssd', ['other'])
  assert.equal(sessionProfile([windows, first, selected], selected, 'factory'), selected)
  assert.equal(sessionProfile([windows, first], windows, 'factory'), first)
  assert.equal(sessionProfile([windows, first, selected], windows, 'factory'), windows)
  assert.equal(sessionProfile([windows, unrelated], windows, 'ssd'), windows)
  assert.equal(fallbackProfile([windows, unrelated], windows), undefined)
  assert.equal(fallbackProfile([windows, first], windows), first)
  assert.equal(fallbackProfile([windows, first, selected], windows), undefined)
})
test('security failures are distinct from transient transport failures', () => {
  for (const text of ['HTTP 401', 'Vínculo revocado', 'Crow rechazó la autenticación del dispositivo']) { assert.equal(revokedConnection(text), true); assert.equal(retryableConnection(text), false) }
  for (const text of ['Sin respuesta de Crow en 15 segundos', 'Sin conexión', 'network error']) assert.equal(retryableConnection(text), true)
  assert.equal(retryableConnection('TLS: huella inválida'), false)
  assert.equal(retryableConnection('HTTP 403'), false)
})
