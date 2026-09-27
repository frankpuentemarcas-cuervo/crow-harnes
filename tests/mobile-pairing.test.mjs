import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mobilePairingURL, pairingCodeFromHash } from '../src/shared/mobile-pairing.ts'

test('QR carries a single-use pairing code in the HTTPS fragment', () => {
  const code = '0A1B2C3D4E5F6789'
  const value = mobilePairingURL('https://192.168.1.5:42381', code)
  assert.equal(value, `https://192.168.1.5:42381/#pair=${code}`)
  assert.equal(pairingCodeFromHash(new URL(value).hash), code)
  assert.equal(new URL(value).search, '')
})

test('invalid links and fragments cannot auto-pair', () => {
  assert.throws(() => mobilePairingURL('http://192.168.1.5:42381', '0A1B2C3D4E5F6789'))
  assert.throws(() => mobilePairingURL('https://192.168.1.5:42381', 'weak'))
  assert.equal(pairingCodeFromHash('#pair=weak'), null)
  assert.equal(pairingCodeFromHash('#other=0A1B2C3D4E5F6789'), null)
})
