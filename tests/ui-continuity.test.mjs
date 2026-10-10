import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { canFocusTerminal, RequestVersions, sidebarWidth, visibleSidebarWidth, withoutSessionTabs } from '../src/renderer/src/ui-continuity.ts'

test('renderer actions do not use native blocking dialogs', () => {
  for (const file of readdirSync(new URL('../src/renderer/src/', import.meta.url)).filter(file => /\.(ts|tsx)$/.test(file))) {
    const source = readFileSync(new URL(`../src/renderer/src/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /window\.(confirm|prompt|alert)\(/, file)
  }
})
test('late terminal attach cannot steal focus from fields, buttons or dialogs', () => {
  const body = {}, inside = {}, input = {}, button = {}
  const surface = { contains: element => element === inside }
  const document = { body, activeElement: body, querySelector: () => null }
  assert.equal(canFocusTerminal(document, surface), true)
  document.activeElement = inside
  assert.equal(canFocusTerminal(document, surface), true)
  for (const field of [input, button]) {
    document.activeElement = field
    assert.equal(canFocusTerminal(document, surface), false)
  }
  document.activeElement = body
  document.querySelector = () => ({ open: true })
  assert.equal(canFocusTerminal(document, surface), false)
})
test('old session snapshots are rejected after refresh or deletion, host isolated', () => {
  const versions = new RequestVersions()
  const old = versions.begin('A'), other = versions.begin('B'), next = versions.begin('A')
  assert.equal(versions.current('A', old), false)
  assert.equal(versions.current('A', next), true)
  assert.equal(versions.current('B', other), true)
  versions.begin('A') // A successful deletion invalidates snapshots requested before it.
  assert.equal(versions.current('A', next), false)
})
test('sidebar width defaults safely and persists bounded usable sizes', () => {
  for (const invalid of [undefined, null, '', NaN, 'broken', 50, -1]) assert.equal(sidebarWidth(invalid), 280)
  assert.equal(sidebarWidth('400'), 400)
  assert.equal(sidebarWidth(1000), 560)
  assert.equal(sidebarWidth(280), 280)
})
test('expanding sidebar keeps space for workspace at minimum desktop size', () => {
  assert.equal(visibleSidebarWidth(560, 1050), 400)
  assert.equal(visibleSidebarWidth(560, 1440), 560)
  assert.equal(visibleSidebarWidth(340, 1440), 340)
})
test('deletion filters current tabs only, preserving tabs opened or closed while pending', () => {
  const old = [{ id: 'deleted', projectId: 'A', sessionId: 'one' }, { id: 'closed-during-request', projectId: 'A', sessionId: 'two' }]
  const current = [old[0], { id: 'new', projectId: 'A', sessionId: 'three' }, { id: 'other-host', projectId: 'B', sessionId: 'one' }, { id: 'editor', projectId: 'A' }]
  assert.deepEqual(withoutSessionTabs(current, new Set(['A']), 'one').map(tab => tab.id), ['new', 'other-host', 'editor'])
  assert.equal(old.length, 2)
})
