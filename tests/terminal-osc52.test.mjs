import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import xterm from '@xterm/xterm'
import { decodeOsc52Selection } from '../src/renderer/src/terminal-osc52.ts'

const { Terminal } = xterm

test('decodes Claude clipboard text as UTF-8 and rejects OSC 52 reads', () => {
  const encoded = Buffer.from('Línea de Claude 🐦').toString('base64')
  assert.equal(decodeOsc52Selection(`c;${encoded}`), 'Línea de Claude 🐦')
  assert.equal(decodeOsc52Selection('c;?'), null)
  assert.equal(decodeOsc52Selection('c;'), null)
  assert.equal(decodeOsc52Selection(`p;${encoded}`), 'Línea de Claude 🐦')
  assert.equal(decodeOsc52Selection(`x;${encoded}`), null)
  assert.equal(decodeOsc52Selection('c;%%%'), null)
  assert.equal(decodeOsc52Selection(`c;${Buffer.from([0xff]).toString('base64')}`), null)
  assert.equal(decodeOsc52Selection(`c;${Buffer.alloc(1024 * 1024 + 1).toString('base64')}`), null)
})

test('xterm parser exposes OSC 52 from remote output for an explicit Copy action', async () => {
  const terminal = new Terminal()
  const selections = []
  const handler = terminal.parser.registerOscHandler(52, (data) => {
    const selected = decodeOsc52Selection(data)
    if (selected) selections.push(selected)
    return true
  })
  try {
    const payload = Buffer.from('texto elegido').toString('base64')
    await new Promise((resolve) => terminal.write(`\x1b]52;c;${payload}\x07`, resolve))
    await new Promise((resolve) => terminal.write('\x1b]52;c;?\x1b\\', resolve))
    assert.deepEqual(selections, ['texto elegido'])
  } finally { handler.dispose(); terminal.dispose() }
})
