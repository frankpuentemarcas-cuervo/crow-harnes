import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { AlertAuditStore } from '../src/main/alert-audit-store.ts'

// A deterministic test cipher, NOT encryption used by the application.
const encryption = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text.split('').reverse().join('')), decryptString: bytes => bytes.toString().split('').reverse().join('') }
const event = { id: 'event', sessionId: 'terminal', at: '2026-10-09T00:00:00Z', message: '¿Me autorizás? private-marker Bearer secret-key' }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'crow-audit-'))
  let now = Date.parse(event.at)
  const create = (cipher = encryption) => new AlertAuditStore(dir, cipher, () => now, () => ['secret-key'])
  return { dir, create, advance: ms => { now += ms }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('opt-in encrypted audit preserves text, redacts configured keys and correlates audio', () => {
  const c = setup()
  try {
    const store = c.create()
    assert.equal(store.begin('host', event, 'auto'), undefined)
    store.setEnabled(true)
    const ref = store.begin('host', event, 'auto')
    store.update(ref, { classification: { source: 'ai', decision: 'actionable', detail: 'Petición.' }, explanation: 'Necesita aprobación', reasonCode: 'approval', reportedModel: 'model-a', queueMs: 10, inferenceMs: 50 })
    store.sound('host', 'event', 'scheduled')
    const rows = store.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].input, undefined)
    const row = store.detail(rows[0].id)
    assert.ok(row.input.includes('private-marker'))
    assert.ok(!JSON.stringify(row).includes('secret-key'))
    assert.equal(row.inputRedacted, true)
    assert.equal(row.reasonCode, 'approval')
    assert.equal(row.sound[0].outcome, 'scheduled')
    assert.ok(!readFileSync(join(c.dir, 'alert-audit', row.id), 'utf8').includes('private-marker'))
    assert.equal(c.create().detail(row.id).input, row.input)
    assert.equal(store.detail('../state.json'), undefined)
  } finally { c.cleanup() }
})

test('disable and clear invalidate in-flight writes; retention applies to original receipt', () => {
  const c = setup()
  try {
    const store = c.create(); store.setEnabled(true)
    const ref = store.begin('host', event, 'auto')
    store.setEnabled(false); store.update(ref, { explanation: 'late' })
    assert.equal(store.detail(ref.id).explanation, undefined)
    store.setEnabled(true); store.clear(); store.update(ref, { explanation: 'resurrect' })
    store.sound('host', 'event', 'scheduled'); assert.equal(store.list().length, 0)
    const fresh = store.begin('host', event, 'auto')
    c.advance(6 * 86400000); store.update(fresh, { explanation: 'updated' })
    c.advance(86400000 + 1); assert.equal(store.list().length, 0)
    assert.equal(readdirSync(join(c.dir, 'alert-audit')).filter(name => name.endsWith('.bin')).length, 0)
  } finally { c.cleanup() }
})

test('unavailable encryption and damaged ciphertext fail closed without affecting agents', () => {
  const c = setup()
  try {
    const unavailable = c.create({ ...encryption, isEncryptionAvailable: () => false })
    assert.throws(() => unavailable.setEnabled(true), /cifrado/)
    assert.equal(unavailable.begin('host', event, 'auto'), undefined)
    const store = c.create(); store.setEnabled(true)
    const ref = store.begin('host', event, 'auto')
    writeFileSync(join(c.dir, 'alert-audit', ref.id), 'broken')
    assert.equal(store.detail(ref.id), undefined)
    assert.ok(store.status().error)
    assert.equal(store.list().length, 0)
    assert.equal(readFileSync(join(c.dir, 'alert-audit', ref.id), 'utf8'), 'broken')
  } finally { c.cleanup() }
})

test('storage limits rotate oldest events without plaintext files; updates whitelist fields', () => {
  const c = setup()
  try {
    const store = c.create(); store.setEnabled(true)
    const ref = store.begin('host', event, 'auto')
    store.update(ref, { apiKey: 'forbidden', headers: { authorization: 'forbidden' }, explanation: 'safe' })
    assert.ok(!JSON.stringify(store.detail(ref.id)).includes('forbidden'))
    for (let i = 0; i < 501; i++) {
      const id = `${Date.parse(event.at) + i + 1}-${createHash('sha256').update(String(i)).digest('hex')}.bin`
      writeFileSync(join(c.dir, 'alert-audit', id), 'ciphertext')
    }
    store.prune()
    assert.equal(readdirSync(join(c.dir, 'alert-audit')).filter(name => name.endsWith('.bin')).length, 500)
    assert.equal(store.detail(ref.id), undefined)
    // Disk-space cap, independently of event count.
    store.clear()
    for (let i = 0; i < 3; i++) {
      const id = `${Date.parse(event.at) + i + 1}-${createHash('sha256').update(String(i)).digest('hex')}.bin`
      writeFileSync(join(c.dir, 'alert-audit', id), Buffer.alloc(8 * 1024 * 1024))
    }
    store.prune()
    assert.equal(readdirSync(join(c.dir, 'alert-audit')).filter(name => name.endsWith('.bin')).length, 2)
  } finally { c.cleanup() }
})

test('quoted credentials and escaped configured keys are redacted before encryption/export', () => {
  const c = setup()
  try {
    const store = c.create(); store.setEnabled(true)
    const ref = store.begin('host', { ...event, message: 'password="private password" {"api_key":"other-token"} Bearer secret-key' }, 'auto')
    store.update(ref, { explanation: 'password="private password"' })
    const exported = store.exportJSON()
    assert.ok(!exported.includes('private password'))
    assert.ok(!exported.includes('other-token'))
    assert.ok(!exported.includes('secret-key'))
  } finally { c.cleanup() }
})
