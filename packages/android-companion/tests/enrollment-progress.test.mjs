import test from 'node:test'
import assert from 'node:assert/strict'
import { pairEnrollmentItems } from '../src/enrollment-progress.mjs'
import { commitEnrollmentResults } from '../src/enrollment-commit.mjs'

test('one failed host does not block later hosts and retry attempts only the failure', async () => {
  const items = ['Windows', 'SSD', 'FACTORY', 'LAB']
  const attempted = []
  const result = await pairEnrollmentItems(items, async item => {
    attempted.push(item)
    if (item === 'SSD') throw new Error('expired invite')
    return `profile:${item}`
  })
  assert.deepEqual(attempted, ['Windows', 'SSD', 'FACTORY', 'LAB'])
  assert.deepEqual(result.paired, ['profile:Windows', 'profile:FACTORY', 'profile:LAB'])
  assert.deepEqual(result.pending, ['SSD'])
  assert.match(result.failure.message, /expired invite/)
  const retried = await pairEnrollmentItems(result.pending, async item => { attempted.push(item); return `profile:${item}` })
  assert.deepEqual(attempted, ['Windows', 'SSD', 'FACTORY', 'LAB', 'SSD'])
  assert.deepEqual(retried.paired, ['profile:SSD'])
  assert.deepEqual(retried.pending, [])
})

test('all failures retain each failed host and safe per-host errors', async () => {
  const result = await pairEnrollmentItems(['SSD', 'FACTORY'], async item => { throw new Error(`${item} expired`) })
  assert.deepEqual(result.paired, [])
  assert.deepEqual(result.pending, ['SSD', 'FACTORY'])
  assert.deepEqual(result.failures.map(entry => entry.error.message), ['SSD expired', 'FACTORY expired'])
})

test('complete pairing leaves no pending entries or failure', async () => {
  const result = await pairEnrollmentItems(['Windows'], async item => item)
  assert.deepEqual(result, { paired: ['Windows'], pending: [], failure: undefined, failures: [] })
})

test('profile activation may clear old notices, but partial-enrollment notice is set afterwards and remains visible', () => {
  let notice = 'expired FACTORY invite'
  let enrolling = true
  const order = []
  commitEnrollmentResults([{ id: 'windows-profile' }], '2 linked; FACTORY still pending', {
    bumpGeneration: () => order.push('bump'),
    appendProfiles: () => order.push('append'),
    activateProfile: () => { order.push('activate'); notice = '' },
    setError: value => { order.push('notice'); notice = value },
    closeEnrollment: () => { enrolling = false },
    showHome: () => order.push('home')
  })
  assert.deepEqual(order, ['bump', 'append', 'activate', 'notice'])
  assert.equal(notice, '2 linked; FACTORY still pending')
  assert.equal(enrolling, true)
})
