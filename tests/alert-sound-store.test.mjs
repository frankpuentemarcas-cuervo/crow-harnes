import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlertSoundStore, MAX_ALERT_SOUND_BYTES, validateAlertSound } from '../src/main/alert-sound-store.ts'

const sound = { name: 'aviso.mp3', dataBase64: Buffer.from('audio de prueba').toString('base64') }

test('custom sound is copied to local storage and can be restored to default', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crow-alert-test-'))
  try {
    const store = new AlertSoundStore(directory)
    assert.equal(store.load(), null)
    store.save(sound)
    assert.deepEqual(store.load(), sound)
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'alert-sound.json'), 'utf8')), sound)
    store.clear()
    assert.equal(store.load(), null)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('rejects unsafe names, malformed data and files above the limit', () => {
  for (const name of ['../aviso.mp3', 'C:\\aviso.wav', 'aviso.exe', 'a'.repeat(121) + '.mp3']) {
    assert.throws(() => validateAlertSound({ ...sound, name }))
  }
  assert.throws(() => validateAlertSound({ ...sound, dataBase64: 'abcd!' }))
  assert.throws(() => validateAlertSound({ ...sound, dataBase64: Buffer.alloc(MAX_ALERT_SOUND_BYTES + 1).toString('base64') }))
})

test('corrupted stored sound does not silently replace the configured one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crow-alert-test-'))
  try {
    const store = new AlertSoundStore(directory)
    store.save(sound)
    assert.throws(() => store.save({ ...sound, dataBase64: 'invalid!' }))
    assert.deepEqual(store.load(), sound)
    writeFileSync(join(directory, 'alert-sound.json'), '{bad-json')
    assert.throws(() => store.load())
    store.clear()
    assert.equal(store.load(), null)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
