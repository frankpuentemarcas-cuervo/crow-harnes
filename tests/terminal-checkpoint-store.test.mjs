import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalCheckpointStore } from '../src/main/terminal-checkpoint-store.ts'

const secure = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(byte => byte ^ 0x5a), decryptString: bytes => Buffer.from(bytes).map(byte => byte ^ 0x5a).toString() }
test('terminal checkpoints persist encrypted sequence and can be removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure), state = '\u001b[31mprivate terminal output\u001b[0m'
    store.save('host-1', '0123456789abcdef0123456789abcdef', { seq: 47, state })
    const files = readdirSync(join(dir, 'terminal-checkpoints'))
    assert.equal(files.length, 1)
    assert.ok(!readFileSync(join(dir, 'terminal-checkpoints', files[0]), 'utf8').includes('private terminal output'))
    assert.deepEqual(store.load('host-1', '0123456789abcdef0123456789abcdef'), { seq: 47, state })
    store.remove('host-1', '0123456789abcdef0123456789abcdef')
    assert.equal(store.load('host-1', '0123456789abcdef0123456789abcdef'), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('terminal checkpoints reject invalid ids and oversized states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure)
    assert.throws(() => store.load('../host', '0123456789abcdef0123456789abcdef'), /inválida/)
    store.save('host', '0123456789abcdef0123456789abcdef', { seq: 1, state: 'x'.repeat(8_000_001) })
    assert.equal(readdirSync(dir).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
