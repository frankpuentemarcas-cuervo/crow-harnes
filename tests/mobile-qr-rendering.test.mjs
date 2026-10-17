import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode')
const { PNG } = require('pngjs')
const { mobileQrModulePixels } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(readFileSync(new URL('../src/renderer/src/mobile-qr-layout.ts', import.meta.url), 'utf8'), { mode: 'transform' })).toString('base64'))

// Synthetic but schema-shaped enrollment data only; never use a live invite or credential.
function sanitizedDenseBundle() {
  let seed = 17
  const token = length => Array.from({ length }, () => { seed = (seed * 48271) % 2147483647; return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[seed % 62] }).join('')
  const enrollments = Array.from({ length: 15 }, (_, i) => ({
    hostId: `host-${i}`,
    hostName: token(80),
    enrollment: { version: 2, gatewayId: `gateway-${token(18)}`, invitationCode: token(32), expiresAt: '2099-01-01T00:00:00.000Z', endpoints: [{ kind: 'remote-public', url: `https://host-${i}.example.test/` }] }
  }))
  return JSON.stringify({ version: 3, enrollments })
}

test('dense sanitized enrollment QR keeps a four-module quiet zone and exact native module pixels', async () => {
  const bundle = sanitizedDenseBundle()
  const compressed = `crow3:${(await import('node:zlib')).gzipSync(Buffer.from(bundle)).toString('base64url')}`
  const payload = Buffer.byteLength(compressed) < Buffer.byteLength(bundle) ? compressed : bundle
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'L' })
  const png = PNG.sync.read(await QRCode.toBuffer(payload, { scale: 6, margin: 4, errorCorrectionLevel: 'L' }))
  const totalModules = qr.modules.size + 8
  assert.equal(png.width, totalModules * 6)
  assert.equal(png.height, totalModules * 6)
  assert.ok(qr.modules.size >= 120, `fixture must represent a dense real QR; got ${qr.modules.size} modules`)
  if (process.env.CROW_QR_FIXTURE_OUTPUT) writeFileSync(process.env.CROW_QR_FIXTURE_OUTPUT, PNG.sync.write(png))
  console.log(`Sanitized fixture: ${Buffer.byteLength(payload)} UTF-8 bytes, ${qr.modules.size} modules, ${png.width}x${png.height} native PNG pixels, 6 px/module, 4-module quiet zone`)
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const pixel = (y * png.width + x) * 4
    const quietZone = x < 24 || y < 24 || x >= png.width - 24 || y >= png.height - 24
    if (quietZone) assert.deepEqual([...png.data.subarray(pixel, pixel + 3)], [255, 255, 255])
    else {
      const module = qr.modules.data[Math.floor(y / 6 - 4) * qr.modules.size + Math.floor(x / 6 - 4)]
      const expected = module ? 0 : 255
      assert.equal(png.data[pixel], expected)
      assert.equal(png.data[pixel + 1], expected)
      assert.equal(png.data[pixel + 2], expected)
    }
  }
})

test('large-scan QR sizing stays integer-scaled and legible at common Windows work areas', () => {
  const bundle = sanitizedDenseBundle()
  const compressed = `crow3:${require('node:zlib').gzipSync(Buffer.from(bundle)).toString('base64url')}`
  const payload = Buffer.byteLength(compressed) < Buffer.byteLength(bundle) ? compressed : bundle
  const modules = QRCode.create(payload, { errorCorrectionLevel: 'L' }).modules.size
  const viewports = [
    { label: '1920x1080 @100%', width: 1920, height: 1080, dpr: 1 },
    { label: '1366x768 @125% full client area', width: 1093, height: 614, dpr: 1.25 },
    { label: '1366x768 @125%, taskbar/frame deducted', width: 1093, height: 590, dpr: 1.25 },
    { label: '1920x1080 @150%', width: 1280, height: 720, dpr: 1.5 },
    { label: '1920x1080 @200%', width: 960, height: 540, dpr: 2 }
  ]
  for (const viewport of viewports) {
    const px = mobileQrModulePixels(modules, viewport.width, viewport.height, true, viewport.dpr)
    const dimension = (modules + 8) * px
    const physicalModulePixels = px * viewport.dpr
    assert.ok(Number.isInteger(physicalModulePixels) && physicalModulePixels >= 2, `${viewport.label}: ${physicalModulePixels} physical px per module`)
    assert.ok(dimension <= Math.min(viewport.width - 32, 922), `${viewport.label}: QR exceeds focused overlay content width`)
    assert.ok(dimension <= viewport.height - 190, `${viewport.label}: QR exceeds scan-mode height budget`)
    if (physicalModulePixels < 3) assert.match(readFileSync(new URL('../src/renderer/src/MobileDialog.tsx', import.meta.url), 'utf8'), /mobile-qr-compact-warning/)
  }
})

test('preview offers a same-invitation focus view and keeps its original expiry', () => {
  const source = readFileSync(new URL('../src/renderer/src/MobileDialog.tsx', import.meta.url), 'utf8')
  assert.match(source, /Ver QR grande/)
  assert.match(source, /setScanMode\(true\)/)
  assert.match(source, /Este QR temporal no cambia mientras lo escaneás/)
  assert.match(source, /setQR\(result\.qrDataUrl\)/)
  assert.match(source, /className=\{`mobile-dialog\$\{scanMode/)
})
