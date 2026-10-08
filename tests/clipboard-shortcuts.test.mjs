import test from 'node:test'
import assert from 'node:assert/strict'
import { ignoreClipboardMenuShortcut } from '../src/main/clipboard-shortcuts.ts'

const key = (key, extra = {}) => ({ type: 'keyDown', key, control: false, shift: false, alt: false, meta: false, ...extra })

test('clipboard keystrokes reach renderer instead of Electron menu accelerators', () => {
  for (const letter of ['c', 'C', 'v', 'V']) {
    assert.equal(ignoreClipboardMenuShortcut(key(letter, { control: true })), true)
    assert.equal(ignoreClipboardMenuShortcut(key(letter, { control: true, shift: true })), true)
  }
  assert.equal(ignoreClipboardMenuShortcut(key('Insert', { shift: true })), true)
  assert.equal(ignoreClipboardMenuShortcut(key('c', { type: 'keyUp', control: true })), true)
})

test('unrelated menu shortcuts, AltGr and ordinary typing remain unchanged', () => {
  for (const event of [key('c'), key('v'), key('r', { control: true }), key('c', { control: true, alt: true }), key('v', { meta: true }), key('c', { type: 'char', control: true })]) {
    assert.equal(ignoreClipboardMenuShortcut(event), false)
  }
})
