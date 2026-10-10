import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the real effect's promise handlers, not a duplicate generation policy.
function pendingSessionRequest() {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
  const line = source.split('\n').find(value => value.includes('void api<MobileSession[]>(id,') && value.includes('setSessions(result)'))
  assert.ok(line)
  const failed = [], sessions = [], generation = { current: 1 }, active = { current: 'same-profile' }
  let reject
  const request = new Promise((_, deny) => { reject = deny })
  const body = ts.transpileModule(`(async () => { ${line.replace('void api', 'await api')} })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const completion = vm.runInNewContext(body, { api: () => request, id: 'same-profile', hostId: 'host', version: 1, cancelled: false, generation, active, fail: value => failed.push(value), setSessions: value => sessions.push(value), message: value => String(value) })
  return { generation, failed, sessions, reject, completion }
}

test('late failed session fetch cannot invalidate a newer refresh of the same profile', async () => {
  const h = pendingSessionRequest()
  h.generation.current = 2
  h.reject(new Error('old revoked response'))
  await h.completion
  assert.deepEqual(h.failed, [])
  assert.deepEqual(h.sessions, [])
})

test('current-generation session failures still reach the UI', async () => {
  const h = pendingSessionRequest()
  h.reject(new Error('current revoked response'))
  await h.completion
  assert.equal(h.failed.length, 1)
  assert.match(h.failed[0], /current revoked response/)
})
