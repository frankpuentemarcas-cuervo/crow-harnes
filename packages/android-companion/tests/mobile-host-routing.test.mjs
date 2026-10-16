import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const native = readFileSync(new URL('../src/native.ts', import.meta.url), 'utf8')
const plugin = readFileSync(new URL('../android/app/src/main/java/dev/crow/companion/CrowGatewayPlugin.java', import.meta.url), 'utf8')
const windows = readFileSync(new URL('../../../src/main/mobile-gateway.ts', import.meta.url), 'utf8')

test('one-QR profiles retain host identity and existing terminals use their Linux data-plane anchor', () => {
  assert.match(native, /mobileHostId\?: string/)
  assert.match(app, /mobileHostId: item\.hostId/)
  assert.match(plugin, /put\("mobileHostId", call\.getString\("mobileHostId", ""\)\)/)
  assert.match(app, /profiles\.find\(item => item\.mobileHostId === terminal\.hostId && item\.mobileHostId !== 'windows'\)/)
  assert.match(windows, /hostId: scope\.hostId/)
  assert.match(app, /profile\?\.mobileHostId === 'windows'[\s\S]*?profiles\.find\(candidate => candidate\.mobileHostId && candidate\.mobileHostId !== 'windows'\)/)
})
