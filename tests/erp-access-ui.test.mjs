import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { projectVisibleSessions, withoutHostWorkspace } from '../src/shared/access-visibility.ts'

const sample = () => ({ hosts: [{ id: 'A' }, { id: 'B' }], projects: [{ id: 'pa', hostId: 'A' }, { id: 'pb', hostId: 'B' }], notices: [{ hostId: 'A', sessionId: 'mine' }, { hostId: 'A', sessionId: 'other' }, { hostId: 'B', sessionId: 'mine' }], sessionNames: { 'A:mine': 'mine', 'A:other': 'private', 'B:mine': 'B' }, tabs: [{ id: 'ta', projectId: 'pa', kind: 'terminal', sessionId: 'mine' }, { id: 'foreign', projectId: 'pa', kind: 'terminal', sessionId: 'other' }, { id: 'editor', projectId: 'pa', kind: 'editor' }, { id: 'browser', projectId: 'pa', kind: 'browser' }, { id: 'tb', projectId: 'pb', kind: 'terminal', sessionId: 'mine' }], activeTabs: { pa: 'foreign', pb: 'tb' }, eventCursors: {}, selectedProjectId: 'pa' })

test('cached session notices, names and tabs require current host-scoped permission', () => {
  const source = sample(), result = projectVisibleSessions(source, new Set(['A:mine']))
  assert.deepEqual(result.notices, [{ hostId: 'A', sessionId: 'mine' }])
  assert.deepEqual(result.sessionNames, { 'A:mine': 'mine' })
  assert.deepEqual(result.tabs.map(tab => tab.id), ['ta', 'editor', 'browser'])
  assert.deepEqual(result.activeTabs, {})
  assert.equal(source.notices.length, 3)
})

test('missing permission fails closed and identity switch removes editor/browser caches too', () => {
  const result = projectVisibleSessions(sample(), new Set())
  assert.equal(result.notices.length, 0); assert.deepEqual(result.sessionNames, {})
  const switched = withoutHostWorkspace(sample(), 'A')
  assert.deepEqual(switched.tabs.map(tab => tab.id), ['tb'])
  assert.deepEqual(switched.sessionNames, { 'B:mine': 'B' })
  assert.deepEqual(switched.activeTabs, { pb: 'tb' })
})

test('preload exposes explicit approval but no secrets readback or generic IPC bridge', () => {
  const source = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  assert.match(source, /erpApprove:.*crow:erp-approve/)
  assert.match(source, /accessImportCredential:.*crow:access-import/)
  assert.doesNotMatch(source, /getERPSecret|erpSecret|sendIPC|invokeIPC/)
})

test('renderer requires exact prompt review and separate manual completion; readonly input blocked', () => {
  const source = readFileSync(new URL('../src/renderer/src/ERPTaskKanban.tsx', import.meta.url), 'utf8')
  assert.match(source, /DocType.*<strong>Task<\/strong>/)
  assert.match(source, /preview\.initialPrompt/)
  assert.match(source, /Autorizar nueva terminal y enviar esta Task/)
  assert.match(source, /NO marca la tarea como hecha/)
  assert.match(source, /type="password"/)
  assert.match(source, /allowAIClassification: consent/)
  const terminal = readFileSync(new URL('../src/renderer/src/TerminalPane.tsx', import.meta.url), 'utf8')
  assert.match(terminal, /subscription\.current && !readonlyRef\.current/)
  assert.match(terminal, /readonlyRef\.current \|\| !subscription\.current/)
  assert.match(terminal, /if \(readonlyRef\.current\) return/)
})
