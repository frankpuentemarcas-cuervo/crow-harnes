import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { decodeCompletionSound, isFreshNotice, playCompletionSound } from '../src/renderer/src/completion-sound.ts'

test('sound is reserved for recent events, allowing modest host clock skew', () => {
  const now = Date.parse('2026-09-27T21:30:00Z')
  assert.equal(isFreshNotice('2026-09-27T21:29:30Z', now), true)
  assert.equal(isFreshNotice('2026-09-27T21:30:30Z', now), true)
  assert.equal(isFreshNotice('2026-09-27T21:20:00Z', now), false)
  assert.equal(isFreshNotice('not-a-date', now), false)
})

test('decoded custom sound is played instead of the default tone', async () => {
  const previous = globalThis.AudioContext
  const played = []
  let source
  globalThis.AudioContext = class {
    state = 'running'
    currentTime = 0
    destination = {}
    async decodeAudioData() { return { duration: 2 } }
    createBufferSource() {
      source = { connect() {}, start(at) { played.push(at) }, set buffer(value) { played.push(value.duration) } }
      return source
    }
  }
  try {
    const decoded = await decodeCompletionSound(Buffer.from('audio').toString('base64'))
    await playCompletionSound(decoded, () => played.push('ended'))
    assert.deepEqual(played, [2, 0.02])
    source.onended()
    assert.deepEqual(played, [2, 0.02, 'ended'])
  } finally { globalThis.AudioContext = previous }
})
