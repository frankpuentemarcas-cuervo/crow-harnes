import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isTransportFailure } from '../src/main/transport-failure.ts'

test('transport errors require a health probe', () => {
  assert.equal(isTransportFailure(new TypeError('fetch failed')), true)
  assert.equal(isTransportFailure(new DOMException('timed out', 'TimeoutError')), true)
  assert.equal(isTransportFailure(new DOMException('aborted', 'AbortError')), true)
})

test('application and HTTP errors do not reset a healthy tunnel', () => {
  assert.equal(isTransportFailure(new Error('HTTP 502')), false)
  assert.equal(isTransportFailure(new SyntaxError('invalid JSON')), false)
  assert.equal(isTransportFailure('fetch failed'), false)
})
