import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { NoticeSoundTracker } from '../src/renderer/src/session-notices.ts'

const now = Date.parse('2026-10-09T00:00:00Z')
const notice = (patch = {}) => ({ id: 'a', hostId: 'host', sessionId: 'session', seq: 1, kind: 'turn-complete', at: new Date(now).toISOString(), read: false, requiresAttention: true, ...patch })
const pending = (patch = {}) => notice({ requiresAttention: false, classification: { source: 'pending', decision: 'uncertain', detail: '' }, ...patch })

test('an unrelated state snapshot must not pretend that an alert already sounded', () => {
  const tracker = new NoticeSoundTracker()
  tracker.restore([])
  tracker.accept([], pending(), now)
  const actionable = notice()
  assert.equal(tracker.accept([actionable], actionable, now + 2000), true)
  assert.equal(tracker.accept([actionable], actionable, now + 3000), false)
})

test('a fresh pending alert remains audible when AI crosses the remote date cutoff', () => {
  const tracker = new NoticeSoundTracker()
  const at = new Date(now - 110000).toISOString()
  assert.equal(tracker.accept([], pending({ at }), now), false)
  assert.equal(tracker.accept([], notice({ at }), now + 15000), true)
})

test('history, old reconnect events, informational responses and reviewed alerts stay silent', () => {
  const tracker = new NoticeSoundTracker()
  tracker.restore([notice()])
  assert.equal(tracker.accept([], notice(), now), false)
  const old = { id: 'old', at: new Date(now - 600000).toISOString() }
  tracker.accept([], pending(old), now)
  assert.equal(tracker.accept([], notice(old), now + 1000), false)
  assert.equal(tracker.accept([], notice({ id: 'info', requiresAttention: false }), now), false)
  tracker.accept([], pending({ id: 'reviewed' }), now)
  assert.equal(tracker.accept([notice({ id: 'reviewed', read: true })], notice({ id: 'reviewed' }), now), false)
  assert.equal(tracker.accept([], notice({ id: 'read', read: true }), now), false)
})

test('initial loading does not mute an event already received live; hosts dedupe separately', () => {
  const tracker = new NoticeSoundTracker()
  tracker.accept([], pending(), now)
  tracker.restore([notice()])
  assert.equal(tracker.accept([], notice(), now + 1000), true)
  assert.equal(tracker.accept([], notice({ hostId: 'other' }), now + 1000), true)
})

test('pending redelivery does not extend freshness forever', () => {
  const tracker = new NoticeSoundTracker()
  tracker.accept([], pending(), now)
  tracker.accept([], pending(), now + 119000)
  assert.equal(tracker.accept([], notice(), now + 130000), false)
})
