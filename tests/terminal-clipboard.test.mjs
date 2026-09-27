import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { terminalClipboardAction } from '../src/renderer/src/terminal-clipboard.ts'

function key(key, options = {}) {
  return { type: 'keydown', key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...options }
}

test('copy selection with Ctrl+C or Ctrl+Shift+C without stealing interrupt', () => {
  assert.equal(terminalClipboardAction(key('c', { ctrlKey: true }), true), 'copy')
  assert.equal(terminalClipboardAction(key('c', { ctrlKey: true }), false), null)
  assert.equal(terminalClipboardAction(key('C', { ctrlKey: true, shiftKey: true }), false), 'copy')
})

test('paste with Windows terminal shortcuts but leave unrelated keys alone', () => {
  assert.equal(terminalClipboardAction(key('v', { ctrlKey: true }), false), 'paste')
  assert.equal(terminalClipboardAction(key('V', { ctrlKey: true, shiftKey: true }), false), 'paste')
  assert.equal(terminalClipboardAction(key('Insert', { shiftKey: true }), false), 'paste')
  assert.equal(terminalClipboardAction(key('v', { ctrlKey: true, altKey: true }), false), null)
  assert.equal(terminalClipboardAction({ ...key('v', { ctrlKey: true }), type: 'keyup' }, false), null)
})
