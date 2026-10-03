import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { unreadNoticesForSession, unreadNoticesForTab, unreadSessionCountForProject } from '../src/renderer/src/session-notices.ts'

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

test('selecting a terminal acknowledges all its unread alerts without affecting other terminals', () => {
  const notices = [notice('a', 'host-a', 'session-a'), notice('b', 'host-a', 'session-a'), notice('c', 'host-b', 'session-a'), notice('d', 'host-a', 'session-b')]
  const projects = [{ id: 'project-a', hostId: 'host-a' }]
  const tab = { id: 'tab-a', projectId: 'project-a', kind: 'terminal', sessionId: 'session-a' }
  const reviewed = new Set(unreadNoticesForTab(notices, projects, tab).map((item) => item.id))
  assert.deepEqual([...reviewed], ['a', 'b'])
  const afterClick = notices.map((item) => reviewed.has(item.id) ? { ...item, read: true } : item)
  assert.deepEqual(unreadNoticesForTab(afterClick, projects, tab), [])
  assert.deepEqual(afterClick.filter((item) => !item.read).map((item) => item.id), ['c', 'd'])
  assert.deepEqual(unreadNoticesForTab([...afterClick, notice('new', 'host-a', 'session-a')], projects, tab).map((item) => item.id), ['new'])
})

test('selecting a browser, editor or unavailable terminal leaves alerts unread', () => {
  const notices = [notice('a', 'host-a', 'session-a')]
  const projects = [{ id: 'project-a', hostId: 'host-a' }]
  const tab = { id: 'tab-a', projectId: 'project-a', sessionId: 'session-a' }
  for (const kind of ['browser', 'editor']) assert.deepEqual(unreadNoticesForTab(notices, projects, { ...tab, kind }), [])
  assert.deepEqual(unreadNoticesForTab(notices, projects, { ...tab, kind: 'terminal', sessionId: undefined }), [])
  assert.deepEqual(unreadNoticesForTab(notices, [], { ...tab, kind: 'terminal' }), [])
})
