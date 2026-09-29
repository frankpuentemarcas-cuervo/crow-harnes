import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { remoteApiError } from '../src/main/remote-errors.ts'

test('missing new runtime routes explain that crowd must be updated', () => {
  for (const [method, path] of [
    ['GET', '/api/host/metrics'],
    ['GET', '/api/hooks'],
    ['DELETE', `/api/sessions/${'a'.repeat(32)}`],
    ['POST', '/api/files/upload'],
    ['GET', '/api/files/download']
  ]) {
    assert.match(remoteApiError(404, '404 page not found\n', method, path).message, /desactualizado/)
  }
})

test('a deleted session is not mistaken for an old runtime', () => {
  assert.equal(remoteApiError(404, 'session not found\n', 'DELETE', `/api/sessions/${'a'.repeat(32)}`).message, 'session not found')
  assert.equal(remoteApiError(500, 'disk error', 'GET', '/api/host/metrics').message, 'disk error')
})
