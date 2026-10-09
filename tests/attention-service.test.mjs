import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store.ts'
import { AttentionService } from '../src/main/attention-service.ts'
import { aiClassification } from '../src/main/attention-classifier.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
function setup(classify, audit, now = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), 'crow-attention-'))
  const store = new Store(directory)
  const emitted = [], statuses = []
  const settings = { enabled: true, model: 'auto' }
  const api = { snapshot: () => settings, configuration: () => ({ baseURL: 'http://127.0.0.1:31415/v1', model: 'auto', apiKey: 'test-key' }) }
  const service = new AttentionService(store, api, notice => emitted.push(structuredClone(notice)), status => statuses.push(status), classify, now, audit)
  const event = (seq, patch = {}) => ({ id: String(seq), seq, sessionId: 'terminal-a', kind: 'turn-complete', at: new Date().toISOString(), requiresAttention: false, message: '¿Me autorizás a resetear las contraseñas? private-marker', ...patch })
  return { service, store, emitted, statuses, settings, event, directory, cleanup: () => { service.stop(); rmSync(directory, { recursive: true, force: true }) } }
}

test('async classification replaces pending event, preserves read and dedupes model calls', async () => {
  let release, calls = 0
  const context = setup(async () => { calls++; return new Promise(resolve => { release = resolve }) })
  try {
    const { service, store, event, emitted, directory } = context
    service.receive('host-a', event(1))
    assert.equal(emitted[0].classification.source, 'pending')
    assert.equal(emitted[0].requiresAttention, false)
    assert.ok(!JSON.stringify(emitted).includes('private-marker'))
    store.markNoticeRead('1') // Visit while model is still analyzing.
    service.receive('host-a', event(1))
    release(aiClassification('actionable'))
    await tick()
    assert.equal(calls, 1)
    assert.equal(store.snapshot().notices.length, 1)
    assert.equal(emitted.at(-1).requiresAttention, true)
    assert.equal(emitted.at(-1).read, true)
    assert.ok(!readFileSync(join(directory, 'state.json'), 'utf8').includes('private-marker'))
  } finally { context.cleanup() }
})

test('informational result is silent; uncertain/error/missing text are visible fallbacks', async () => {
  for (const [decision, attention] of [['informational', false], ['actionable', true], ['uncertain', true]]) {
    const c = setup(async () => aiClassification(decision))
    try { c.service.receive('host', c.event(1)); await tick(); assert.equal(c.emitted.at(-1).requiresAttention, attention) }
    finally { c.cleanup() }
  }
  const c = setup(async () => { throw new Error('Free LLM HTTP 429') })
  try {
    c.service.receive('host', c.event(1)); await tick()
    assert.equal(c.emitted.at(-1).classification.source, 'fallback')
    assert.equal(c.emitted.at(-1).requiresAttention, true)
    assert.equal(c.statuses.at(-1).state, 'error')
    c.service.receive('host', c.event(2))
    assert.equal(c.emitted.at(-1).classification.source, 'fallback')
    for (const patch of [{ message: undefined }, { messageTruncated: true }]) {
      c.service.reset(); c.service.receive('host', c.event(catchSeq++, patch))
      assert.equal(c.emitted.at(-1).classification.source, 'fallback')
    }
  } finally { c.cleanup() }
})
let catchSeq = 3

test('bounds concurrency/queue, cancels on reconfiguration and never alerts deleted notices', async () => {
  const releases = [], cancellations = []
  const c = setup(async (_config, _text, signal) => { cancellations.push(signal); return new Promise(resolve => releases.push(resolve)) })
  try {
    for (let i = 1; i <= 41; i++) c.service.receive('host', c.event(i))
    assert.equal(releases.length, 2)
    assert.equal(c.emitted.at(-1).classification.source, 'fallback')
    c.service.reset()
    assert.ok(cancellations.every(signal => signal.aborted))
    assert.equal(c.store.snapshot().notices.filter(n => n.classification.source === 'pending').length, 0)
    const count = c.emitted.length
    for (const release of releases) release(aiClassification('actionable'))
    await tick()
    assert.equal(c.emitted.length, count)
    c.service.receive('host', c.event(42))
    c.store.removeSession('host', 'terminal-a')
    releases.at(-1)(aiClassification('actionable'))
    await tick()
    assert.equal(c.store.snapshot().notices.length, 0)
  } finally { c.cleanup() }
})

test('disabled AI keeps existing rules, and a restart converts unfinished analysis to review', () => {
  const c = setup(async () => new Promise(() => {}))
  try {
    c.settings.enabled = false
    c.service.receive('host', c.event(1, { requiresAttention: true }))
    assert.equal(c.emitted[0].classification.source, 'rules')
    assert.equal(c.emitted[0].requiresAttention, true)
    c.settings.enabled = true
    c.service.receive('host', c.event(2))
    const reopened = new Store(c.directory)
    assert.equal(reopened.snapshot().notices[0].classification.source, 'fallback')
    assert.equal(reopened.snapshot().notices[0].requiresAttention, true)
  } finally { c.cleanup() }
})

test('test connection evaluates three fictional semantic cases and exposes failures', async () => {
  const decisions = ['actionable', 'informational', 'informational'], texts = []
  const c = setup(async (_config, text) => { texts.push(text); return aiClassification(decisions.shift()) })
  try {
    assert.equal((await c.service.testConnection()).state, 'ok')
    assert.equal(texts.length, 3)
    assert.ok(!texts.join('').includes('private-marker'))
    assert.equal(c.emitted.length, 0)
    assert.equal((await c.service.testConnection()).state, 'error')
  } finally { c.cleanup() }
})

test('audit correlates input, reported model, timing and verdict while keeping notices private', async () => {
  let now = Date.now()
  const begins = [], updates = []
  const audit = { begin: (...args) => { begins.push(args); return { id: 'ref', generation: 0 } }, update: (ref, patch) => updates.push({ ref, patch }) }
  const c = setup(async (_config, _message, _cancel, observe) => {
    observe({ httpStatus: 200, reportedModel: 'model-a', reasonCode: 'approval', explanation: 'private-explanation' })
    now += 55
    return aiClassification('actionable')
  }, audit, () => now)
  try {
    const event = c.event(1)
    c.service.receive('host', event); c.service.receive('host', event)
    await tick()
    assert.equal(begins.length, 1)
    assert.equal(begins[0][1].message, event.message)
    assert.equal(begins[0][2], 'auto')
    assert.ok(updates.some(item => item.patch.inferenceMs === 55))
    assert.ok(updates.some(item => item.patch.classification?.decision === 'actionable' && item.patch.finishedAt))
    assert.ok(updates.some(item => item.patch.reportedModel === 'model-a'))
    assert.ok(!JSON.stringify(c.emitted).includes('private-explanation'))
    assert.ok(!readFileSync(join(c.directory, 'state.json'), 'utf8').includes('private-explanation'))
  } finally { c.cleanup() }
})

test('broken audit storage cannot suppress an otherwise valid agent alert', async () => {
  const c = setup(async () => aiClassification('actionable'), { begin: () => { throw Error('disk') }, update: () => { throw Error('disk') } })
  try { c.service.receive('host', c.event(1)); await tick(); assert.equal(c.emitted.at(-1).requiresAttention, true) }
  finally { c.cleanup() }
})
