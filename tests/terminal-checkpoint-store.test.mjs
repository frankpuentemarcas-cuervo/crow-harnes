import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { TerminalCheckpointStore } from '../src/main/terminal-checkpoint-store.ts'

const secure = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(byte => byte ^ 0x5a), decryptString: bytes => Buffer.from(bytes).map(byte => byte ^ 0x5a).toString() }
test('terminal checkpoints persist encrypted sequence and can be removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure), state = '\u001b[31mprivate terminal output\u001b[0m'
    const checkpoint = { seq: 47, state, viewportY: 19 }
    assert.equal(store.save('host-1', '0123456789abcdef0123456789abcdef', checkpoint), 'saved')
    const files = readdirSync(join(dir, 'terminal-checkpoints'))
    assert.equal(files.length, 1)
    assert.ok(!readFileSync(join(dir, 'terminal-checkpoints', files[0]), 'utf8').includes('private terminal output'))
    assert.deepEqual(store.load('host-1', '0123456789abcdef0123456789abcdef'), { status: 'restored', checkpoint })
    store.remove('host-1', '0123456789abcdef0123456789abcdef')
    assert.deepEqual(store.load('host-1', '0123456789abcdef0123456789abcdef'), { status: 'missing' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('terminal checkpoints reject invalid ids and oversized states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure)
    assert.throws(() => store.load('../host', '0123456789abcdef0123456789abcdef'), /inválida/)
    assert.equal(store.save('host', '0123456789abcdef0123456789abcdef', { seq: 1, state: 'x'.repeat(32_000_001) }), 'oversized')
    assert.equal(store.save('host', '0123456789abcdef0123456789abcdef', { seq: 1, state: 'ok', viewportY: -1 }), 'invalid')
    assert.equal(readdirSync(dir).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('oversized replacement preserves the last valid encrypted checkpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure), id = '0123456789abcdef0123456789abcdef'
    store.save('host', id, { seq: 5, state: 'prior', viewportY: 2 })
    assert.equal(store.save('host', id, { seq: 6, state: randomBytes(7_000_000).toString('base64'), viewportY: 0 }), 'oversized')
    assert.deepEqual(store.load('host', id), { status: 'restored', checkpoint: { seq: 5, state: 'prior', viewportY: 2 } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compressed checkpoints round-trip full state larger than the encrypted-file cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure), id = '0123456789abcdef0123456789abcdef'
    const checkpoint = { seq: 91, state: 'scrollback line\r\n'.repeat(600_000), viewportY: 812 }
    assert.ok(Buffer.byteLength(JSON.stringify(checkpoint)) > 8_000_000)
    assert.equal(store.save('host', id, checkpoint), 'saved')
    const path = join(dir, 'terminal-checkpoints', readdirSync(join(dir, 'terminal-checkpoints'))[0])
    assert.ok(readFileSync(path).byteLength < 8_000_000)
    assert.deepEqual(store.load('host', id), { status: 'restored', checkpoint })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy encrypted JSON checkpoints remain readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure), id = '0123456789abcdef0123456789abcdef'
    store.save('host', id, { seq: 4, state: 'placeholder' })
    const path = join(dir, 'terminal-checkpoints', readdirSync(join(dir, 'terminal-checkpoints'))[0])
    const legacy = { seq: 33, state: '\u001b[32mlegacy output\u001b[0m' }
    writeFileSync(path, secure.encryptString(JSON.stringify(legacy)))
    assert.deepEqual(store.load('host', id), { status: 'restored', checkpoint: legacy })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('malformed checkpoint data is reported rather than silently treated as missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure), id = '0123456789abcdef0123456789abcdef'
    store.save('host', id, { seq: 5, state: 'legacy format' })
    const path = join(dir, 'terminal-checkpoints', readdirSync(join(dir, 'terminal-checkpoints'))[0])
    const malformed = Buffer.from(JSON.stringify({ seq: 5, state: 'x', viewportY: -1 })).map(byte => byte ^ 0x5a)
    writeFileSync(path, malformed)
    assert.deepEqual(store.load('host', id), { status: 'invalid' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('oversized and unavailable checkpoints report distinct recovery states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const id = '0123456789abcdef0123456789abcdef', store = new TerminalCheckpointStore(dir, secure)
    store.save('host', id, { seq: 1, state: 'checkpoint' })
    const path = join(dir, 'terminal-checkpoints', readdirSync(join(dir, 'terminal-checkpoints'))[0])
    writeFileSync(path, Buffer.alloc(8_000_001))
    assert.deepEqual(store.load('host', id), { status: 'oversized' })
    assert.deepEqual(new TerminalCheckpointStore(dir, { ...secure, isEncryptionAvailable: () => false }).load('host', id), { status: 'oversized' })
    writeFileSync(path, secure.encryptString(JSON.stringify({ seq: 1, state: 'checkpoint' })))
    assert.deepEqual(new TerminalCheckpointStore(dir, { ...secure, isEncryptionAvailable: () => false }).load('host', id), { status: 'unavailable' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('decompression limit rejects a compressed bomb without truncating its state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-terminal-checkpoint-'))
  try {
    const store = new TerminalCheckpointStore(dir, secure), id = '0123456789abcdef0123456789abcdef'
    const compressed = deflateSync(Buffer.from(JSON.stringify({ seq: 9, state: 'x'.repeat(32_000_001) })))
    store.save('host', id, { seq: 1, state: 'prior checkpoint' })
    const path = join(dir, 'terminal-checkpoints', readdirSync(join(dir, 'terminal-checkpoints'))[0])
    writeFileSync(path, secure.encryptString('CROWCHK1:' + compressed.toString('base64')))
    assert.deepEqual(store.load('host', id), { status: 'oversized' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
