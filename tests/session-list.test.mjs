import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { sessionNameKey, sortSessionsByStart } from '../src/shared/session-list.ts'

const session = (id, startedAt, updatedAt = startedAt) => ({ id, startedAt, updatedAt })

test('session list order stays by creation time even when activity changes', () => {
  const source = [session('b', '2026-10-02T10:00:00Z', '2026-10-02T12:00:00Z'), session('c', '2026-10-02T11:00:00Z'), session('a', '2026-10-02T10:00:00Z')]
  const sorted = sortSessionsByStart(source)
  assert.deepEqual(sorted.map((item) => item.id), ['a', 'b', 'c'])
  assert.deepEqual(source.map((item) => item.id), ['b', 'c', 'a'], 'the source array is not mutated')
  assert.deepEqual(sortSessionsByStart([...source].reverse()).map((item) => item.id), ['a', 'b', 'c'])
})

test('terminal names are keyed by host and session to avoid collisions across servers', () => {
  assert.equal(sessionNameKey('host-a', 'session-1'), 'host-a:session-1')
  assert.notEqual(sessionNameKey('host-a', 'session-1'), sessionNameKey('host-b', 'session-1'))
})
