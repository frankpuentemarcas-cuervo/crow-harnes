import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlertAISettingsStore } from '../src/main/alert-ai-settings.ts'

// Mock encryption to test storage boundaries without an Electron/DPAPI runtime.
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value.split('').reverse().join('')),
  decryptString: value => value.toString().split('').reverse().join('')
}
const input = { enabled: true, baseURL: 'http://127.0.0.1:31415/v1', model: 'auto', apiKey: 'secret-test-key' }

test('opt-in settings survive restart without plaintext key or returning it to renderer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crow-ai-settings-'))
  try {
    const store = new AlertAISettingsStore(directory, encryption)
    assert.equal(store.snapshot().enabled, false)
    assert.equal(store.snapshot().keyPresent, false)
    const result = store.save(input)
    assert.equal(result.enabled, true)
    assert.equal(result.keyPresent, true)
    assert.ok(!JSON.stringify(result).includes(input.apiKey))
    assert.ok(!readFileSync(join(directory, 'alert-ai.json'), 'utf8').includes(input.apiKey))
    const reopened = new AlertAISettingsStore(directory, encryption)
    assert.equal(reopened.configuration().apiKey, input.apiKey)
    reopened.save({ ...input, apiKey: '' })
    assert.equal(reopened.configuration().apiKey, input.apiKey)
    assert.throws(() => reopened.save({ ...input, apiKey: '', baseURL: 'http://127.0.0.1:4444/v1' }))
    assert.throws(() => reopened.save({ ...input, apiKey: '', removeKey: true }))
    reopened.save({ ...input, enabled: false, apiKey: '', removeKey: true })
    assert.equal(reopened.snapshot().keyPresent, false)
    assert.throws(() => reopened.configuration())
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('fails closed when secure encryption is unavailable, invalid models and unsafe URLs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crow-ai-settings-'))
  try {
    const store = new AlertAISettingsStore(directory, { ...encryption, isEncryptionAvailable: () => false })
    assert.throws(() => store.save(input), /seguro/)
    const working = new AlertAISettingsStore(directory, encryption)
    for (const patch of [{ model: 'auto\nsecret' }, { baseURL: 'https://example.com/v1' }, { apiKey: 'secret\nvalue' }, { enabled: true, apiKey: '' }]) assert.throws(() => working.save({ ...input, ...patch }))
    assert.equal(working.snapshot().enabled, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('corrupted settings disable inference and remain recoverable without breaking terminals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crow-ai-settings-'))
  try {
    writeFileSync(join(directory, 'alert-ai.json'), '{bad-json')
    const store = new AlertAISettingsStore(directory, encryption)
    assert.equal(store.snapshot().enabled, false)
    assert.match(store.snapshot().configurationError, /configuración/)
    assert.equal(readFileSync(join(directory, 'alert-ai.json'), 'utf8'), '{bad-json')
    store.save(input)
    assert.equal(store.snapshot().configurationError, undefined)
    assert.equal(store.configuration().apiKey, input.apiKey)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('automatic opening preference migrates old settings, persists and validates without touching the key', () => {
  const directory=mkdtempSync(join(tmpdir(),'crow-ai-settings-'))
  try {
    const store=new AlertAISettingsStore(directory,encryption)
    assert.equal(store.snapshot().autoOpenFreeLLM,true)
    store.save({...input,autoOpenFreeLLM:false})
    const reopened=new AlertAISettingsStore(directory,encryption)
    assert.equal(reopened.snapshot().autoOpenFreeLLM,false)
    reopened.save({...input,apiKey:undefined})
    assert.equal(reopened.snapshot().autoOpenFreeLLM,false)
    assert.equal(reopened.configuration().apiKey,input.apiKey)
    assert.throws(()=>reopened.save({...input,autoOpenFreeLLM:'yes'}))
    const old=JSON.parse(readFileSync(join(directory,'alert-ai.json'),'utf8'));delete old.autoOpenFreeLLM
    writeFileSync(join(directory,'alert-ai.json'),JSON.stringify(old))
    assert.equal(new AlertAISettingsStore(directory,encryption).snapshot().autoOpenFreeLLM,true)
  } finally {rmSync(directory,{recursive:true,force:true})}
})
