import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { terminalClipboardAction, copyTerminalClipboardEvent, pasteTerminalClipboardEvent } from '../src/renderer/src/terminal-clipboard.ts'

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

function clipboardEvent(text = '') {
  return { clipboardData: { getData: () => text, setData: (type, value) => { assert.equal(type, 'text/plain'); text = value } },
    prevented: 0, stopped: 0, preventDefault() { this.prevented++ }, stopPropagation() { this.stopped++ }, read: () => text }
}

test('native copy uses retained or agent selection, not the empty xterm textarea', () => {
  const event = clipboardEvent('old clipboard')
  assert.equal(copyTerminalClipboardEvent(event, 'selección conservada 👋'), true)
  assert.equal(event.read(), 'selección conservada 👋')
  assert.equal(event.prevented, 1)
  assert.equal(event.stopped, 1)
  assert.equal(copyTerminalClipboardEvent(clipboardEvent(), ''), false)
})

test('native paste is delivered once through terminal.paste, preserving multiline text', () => {
  const input = [], event = clipboardEvent('uno\r\ndos')
  assert.equal(pasteTerminalClipboardEvent(event, text => input.push(text)), true)
  assert.deepEqual(input, ['uno\r\ndos'])
  assert.equal(event.prevented, 1)
  assert.equal(event.stopped, 1)
  assert.equal(pasteTerminalClipboardEvent(clipboardEvent(), text => input.push(text)), true)
  assert.equal(input.length, 1)
})
