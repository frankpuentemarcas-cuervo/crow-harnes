import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PendingTerminalSelection } from '../src/renderer/src/terminal-selection.ts'

test('keeps the last non-empty terminal selection through a redraw', () => {
  const pending = new PendingTerminalSelection()
  assert.equal(pending.capture('texto'), true)
  assert.equal(pending.capture(''), true)
  assert.equal(pending.read(''), 'texto')
  assert.equal(pending.hasText(), true)
})

test('replaces a pending selection and clears it after a new interaction', () => {
  const pending = new PendingTerminalSelection()
  pending.capture('anterior')
  pending.capture('nuevo')
  assert.equal(pending.read(''), 'nuevo')
  pending.clear()
  assert.equal(pending.read(''), '')
  assert.equal(pending.hasText(), false)
})
