import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cacheView, CacheWarningTracker, cacheWarningPreferences } from '../src/shared/prompt-cache.ts'
import { CacheBadge } from '../src/renderer/src/CacheBadge.ts'

const now = Date.parse('2026-10-05T12:00:00Z')
const make = (seconds = 180, patch = {}) => ({ id: 'a', agent: 'claude', state: 'running', agentState: 'completed', hooksActive: true, promptCache: { source: 'claude-statusline', conversationId: 'one', ttlSeconds: 300, expiresAt: new Date(now + seconds * 1000).toISOString(), reportedAt: new Date(now).toISOString(), warm: true, observed: true, hitRatio: .96, readTokens: 9600, writtenTokens: 300, freshTokens: 100 }, ...patch })

test('uses native expiry, not completion time, and derives expiry locally', () => {
  const session = make()
  assert.equal(cacheView(session, 'connected', now).state, 'warm')
  assert.equal(cacheView(session, 'connected', now).remainingSeconds, 180)
  assert.equal(cacheView(session, 'connected', now + 180000).state, 'cold')
  assert.equal(cacheView(session, 'connected', now + 180000).remainingSeconds, 0)
})

test('host clock skew and transit time do not extend the countdown', () => {
  const session = make()
  session.promptCache.serverTime = new Date(now + 7200000).toISOString()
  session.promptCache.expiresAt = new Date(now + 7200000 + 45000).toISOString()
  session.promptCache.receivedAt = now - 5000
  assert.equal(cacheView(session, 'connected', now).remainingSeconds, 40)
})

test('unknown, unreported, disconnected and inactive sessions never claim a warm cache', () => {
  const old = make(180, { promptCache: undefined, cacheExpiresAt: new Date(now + 3600000).toISOString() })
  for (const session of [old, make(180, { state: 'interrupted' }), make(180, { hooksActive: false })]) assert.equal(cacheView(session, 'connected', now).state, 'unknown')
  assert.equal(cacheView(make(), 'disconnected', now).state, 'unknown')
  assert.equal(cacheView(make(180, { promptCache: { observed: false, source: 'claude-statusline' } }), 'connected', now).state, 'unobserved')
  assert.equal(cacheView(make(180, { promptCache: { source: 'claude-statusline', warm: true, expiresAt: 'bad' } }), 'connected', now).state, 'unknown')
})

test('cache warnings are once per entry, scoped by host and session; no expired/backlogged warnings', () => {
  const tracker = new CacheWarningTracker()
  const a = { key: 'host:a', session: make(45), status: 'connected' }
  assert.equal(tracker.collect([a], now, { enabled: true, warnSeconds: 60 }).length, 1)
  assert.equal(tracker.collect([a], now + 1000, { enabled: true, warnSeconds: 60 }).length, 0)
  assert.equal(tracker.collect([{ ...a, status: 'disconnected' }], now, { enabled: true, warnSeconds: 60 }).length, 0)
  assert.equal(tracker.collect([a], now, { enabled: true, warnSeconds: 60 }).length, 0)
  assert.equal(tracker.collect([a, { ...a, key: 'other:a' }], now, { enabled: true, warnSeconds: 60 }).length, 1)
  assert.equal(new CacheWarningTracker().collect([{ ...a, session: make(-1) }], now, { enabled: true, warnSeconds: 60 }).length, 0)
  assert.equal(new CacheWarningTracker().collect([a], now, { enabled: false, warnSeconds: 60 }).length, 0)
  assert.equal(new CacheWarningTracker().collect([a], now, { enabled: true, warnSeconds: 30 }).length, 0)
})

test('working agents do not get warnings; renewal and /clear reset the entry, deletion releases state', () => {
  const tracker = new CacheWarningTracker()
  const a = { key: 'a', session: make(45, { agentState: 'working' }), status: 'connected' }
  assert.equal(tracker.collect([a], now, { enabled: true, warnSeconds: 60 }).length, 0)
  a.session.agentState = 'completed'
  assert.equal(tracker.collect([a], now, { enabled: true, warnSeconds: 60 }).length, 1)
  a.session.promptCache.expiresAt = new Date(now + 55000).toISOString()
  assert.equal(tracker.collect([a], now, { enabled: true, warnSeconds: 60 }).length, 1)
  a.session.promptCache.conversationId = 'two'
  assert.equal(tracker.collect([a], now, { enabled: true, warnSeconds: 60 }).length, 1)
  tracker.collect([], now, { enabled: true, warnSeconds: 60 })
  assert.equal(tracker.size, 0)
})

test('warning preferences tolerate corrupted saved data and bound threshold', () => {
  assert.deepEqual(cacheWarningPreferences(null), { enabled: true, warnSeconds: 60 })
  assert.deepEqual(cacheWarningPreferences({ enabled: false, warnSeconds: 120 }), { enabled: false, warnSeconds: 120 })
  for (const value of [-1, 0, 999, '30', Infinity]) assert.equal(cacheWarningPreferences({ warnSeconds: value }).warnSeconds, 60)
})

test('real badge renders meaningful states without announcing every countdown tick', () => {
  const render = (session, status = 'connected') => renderToStaticMarkup(createElement(CacheBadge, { session, status, now }))
  const html = render(make(45))
  for (const text of ['Caché', 'Activa', '0:45', '96%', '5 min', '9,600']) assert.ok(html.includes(text), text)
  assert.ok(!html.includes('aria-live="polite"'))
  assert.ok(render(make(-1)).includes('Vencida'))
  assert.ok(render(make(), 'disconnected').includes('Sin conexión'))
  assert.ok(render(make(45, { promptCache: undefined })).includes('Sin datos'))
})
