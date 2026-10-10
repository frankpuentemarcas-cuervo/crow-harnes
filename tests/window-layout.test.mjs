import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceWindowBounds, workspaceWindowPlacement } from '../src/shared/window-layout.ts'

test('window outer DIP bounds fit the OS work area without reserving a second taskbar', () => {
  assert.deepEqual(workspaceWindowBounds({ width: 1917, height: 1020 }), { width: 1500, height: 920, minWidth: 1050, minHeight: 650 })
  assert.deepEqual(workspaceWindowBounds({ width: 1366, height: 710 }), { width: 1366, height: 710, minWidth: 1050, minHeight: 650 })
  assert.deepEqual(workspaceWindowBounds({ width: 1536, height: 806 }), { width: 1500, height: 806, minWidth: 1050, minHeight: 650 })
  assert.deepEqual(workspaceWindowBounds({ width: 960, height: 590 }), { width: 960, height: 590, minWidth: 960, minHeight: 590 })
})
test('invalid work area falls back to safe startup defaults', () => {
  assert.deepEqual(workspaceWindowBounds({ width: NaN, height: -1 }), { width: 1500, height: 920, minWidth: 1050, minHeight: 650 })
})
test('placement belongs to the chosen display, including negative multi-monitor coordinates', () => {
  assert.deepEqual(workspaceWindowPlacement({ x: -1917, y: 40, width: 1917, height: 1020 }), { width: 1500, height: 920, minWidth: 1050, minHeight: 650, x: -1709, y: 90 })
})
