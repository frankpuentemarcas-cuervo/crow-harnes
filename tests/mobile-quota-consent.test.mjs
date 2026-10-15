import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const dialog = readFileSync(new URL('../src/renderer/src/MobileDialog.tsx', import.meta.url), 'utf8')

test('Android quota permission requires explicit consent when creating a QR', () => {
  assert.match(dialog, /const \[shareQuotas, setShareQuotas\] = useState\(false\)/)
  assert.match(dialog, /capabilities: \{ input: true, create: true, close: false, quotas: shareQuotas \}/)
  assert.match(dialog, /type="checkbox" checked=\{shareQuotas\}/)
  assert.match(dialog, /Los hosts Linux no proporcionan estas cuotas/)
})
