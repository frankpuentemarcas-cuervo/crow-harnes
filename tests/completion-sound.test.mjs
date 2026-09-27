import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isFreshNotice } from '../src/renderer/src/completion-sound.ts'

test('sound is reserved for recent events, allowing modest host clock skew', () => {
  const now = Date.parse('2026-09-27T21:30:00Z')
  assert.equal(isFreshNotice('2026-09-27T21:29:30Z', now), true)
  assert.equal(isFreshNotice('2026-09-27T21:30:30Z', now), true)
  assert.equal(isFreshNotice('2026-09-27T21:20:00Z', now), false)
  assert.equal(isFreshNotice('not-a-date', now), false)
})
