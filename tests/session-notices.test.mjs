import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { unreadNoticesForSession, unreadSessionCountForProject } from '../src/renderer/src/session-notices.ts'

const notice = (id, hostId, sessionId, read = false) => ({ id, hostId, sessionId, read, kind: 'turn-complete', seq: 1, at: '2026-10-02T00:00:00Z' })

test('bell belongs only to unread alerts for the same host and terminal', () => {
  const notices = [notice('a', 'host-a', 'session-a'), notice('b', 'host-a', 'session-a'), notice('c', 'host-b', 'session-a'), notice('d', 'host-a', 'session-b'), notice('e', 'host-a', 'session-a', true)]
  assert.deepEqual(unreadNoticesForSession(notices, 'host-a', 'session-a').map((item) => item.id), ['a', 'b'])
  assert.deepEqual(unreadNoticesForSession(notices.map((item) => ({ ...item, read: true })), 'host-a', 'session-a'), [])
})

test('project indicator counts affected terminals, not repeated alerts', () => {
  const notices = [notice('a', 'host-a', 'session-a'), notice('b', 'host-a', 'session-a'), notice('c', 'host-a', 'session-b'), notice('d', 'host-b', 'session-a')]
  const sessions = [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }]
  assert.equal(unreadSessionCountForProject(notices, 'host-a', sessions), 2)
  assert.equal(unreadSessionCountForProject(notices, 'host-b', sessions), 1)
})
