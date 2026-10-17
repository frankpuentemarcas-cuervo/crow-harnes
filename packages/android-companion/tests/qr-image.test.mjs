import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeQRFrame, readQRImage, MAX_QR_IMAGE_BYTES } from '../src/qr-image.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/qr-image.json', import.meta.url), 'utf8'))
const denseFixture = JSON.parse(readFileSync(new URL('./fixtures/qr-dense-screenshot.json', import.meta.url), 'utf8'))
function pixels(inverted = false) {
  const size = fixture.rows.length, scale = 5, border = 4
  const width = (size + 2 * border) * scale, data = new Uint8ClampedArray(width * width * 4)
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const column = Math.floor(x / scale) - border, row = Math.floor(y / scale) - border
    const dark = row >= 0 && column >= 0 && row < size && column < size && fixture.rows[row][column] === '1'
    const color = (dark ? !inverted : inverted) ? 0 : 255, at = (y * width + x) * 4
    data.set([color, color, color, 255], at)
  }
  return { data, width }
}

function denseScreenshot() {
  const { width, height, panel } = denseFixture.screenshot
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set([27, 31, 38, 255], i)
  const paint = (x, y, color) => data.set([...color, 255], (y * width + x) * 4)
  // A minimal dark Crow-style title/header gives the screenshot non-QR UI content.
  for (let y = 10; y < 37; y++) for (let x = 22; x < 230; x++) if (y < 15 || y > 31 || x < 26 || x > 225) paint(x, y, [205, 210, 218])
  for (let y = panel.y; y < panel.y + panel.height; y++) for (let x = panel.x; x < panel.x + panel.width; x++) paint(x, y, [255, 255, 255])
  const moduleSize = denseFixture.rows.length, scale = 1
  const qrSize = moduleSize * scale, left = panel.x + Math.floor((panel.width - qrSize) / 2), top = panel.y + Math.floor((panel.height - qrSize) / 2)
  for (let row = 0; row < moduleSize; row++) for (let column = 0; column < moduleSize; column++) if (denseFixture.rows[row][column] === '1') {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) paint(left + column * scale + dx, top + row * scale + dy, [0, 0, 0])
  }
  return { data, width, height }
}

function installCanvasMocks(t, source) {
  const oldBitmap = globalThis.createImageBitmap, oldDocument = globalThis.document
  globalThis.createImageBitmap = async () => ({ ...source, close() {} })
  globalThis.document = { createElement: () => {
    let width = 0, height = 0, data = new Uint8ClampedArray()
    return { get data() { return data }, get width() { return width }, set width(v) { width = v; data = new Uint8ClampedArray(width * height * 4) }, get height() { return height }, set height(v) { height = v; data = new Uint8ClampedArray(width * height * 4) }, getContext() { return {
      imageSmoothingEnabled: true,
      drawImage(image, ...args) {
        let sx = 0, sy = 0, sw = image.width, sh = image.height, dx = 0, dy = 0, dw = width, dh = height
        if (args.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args
        else if (args.length === 4) [dx, dy, dw, dh] = args
        const src = image.data
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          const from = (Math.min(image.height - 1, sy + Math.floor(y * sh / dh)) * image.width + Math.min(image.width - 1, sx + Math.floor(x * sw / dw))) * 4
          const to = ((dy + y) * width + dx + x) * 4
          data.set(src.subarray(from, from + 4), to)
        }
      }, getImageData() { return { data } }
    } } }
  } }
  t.after(() => { globalThis.createImageBitmap = oldBitmap; globalThis.document = oldDocument })
}

test('offline decoding returns exact QR bytes for light and dark screenshots', () => {
  for (const inverted of [false, true]) {
    const { data, width } = pixels(inverted)
    assert.equal(decodeQRFrame(data, width, width), fixture.payload)
  }
})

test('dense 1689-character fake expired invite decodes from a screenshot card, not the full UI frame', async t => {
  assert.equal(denseFixture.payload.length, 1689)
  assert.match(denseFixture.payload, /expired-test-fixture/)
  const screenshot = denseScreenshot()
  // The controlled fallback adapter reproduces the reported full-frame failure while preserving
  // jsQR's real decode behavior for the cropped card and the bounded 2x retry.
  assert.equal(decodeQRFrame(screenshot.data, screenshot.width, screenshot.height), denseFixture.payload)
  installCanvasMocks(t, screenshot)
  const attempts = []
  const decoded = await readQRImage({ type: 'image/png', size: 4000 }, (data, width, height) => {
    assert.ok(width * height <= 4 * 1024 * 1024, 'every decoder attempt remains within 4 MP')
    attempts.push([width, height])
    if (attempts.length <= 2) throw new Error(attempts.length === 1 ? 'dense full-frame miss' : 'dense card needs bounded upscale')
    return decodeQRFrame(data, width, height)
  })
  assert.equal(decoded, denseFixture.payload)
  assert.equal(attempts.length, 3)
  assert.ok(attempts.every(([width, height]) => width * height <= 4 * 1024 * 1024))
})

test('blank, malformed and excessive images are rejected without accepting a link', () => {
  assert.throws(() => decodeQRFrame(new Uint8ClampedArray(4), 0, 0), /dimensiones/)
  assert.throws(() => decodeQRFrame(new Uint8ClampedArray(4), 4096, 4096), /demasiado grande/)
  assert.throws(() => decodeQRFrame(new Uint8ClampedArray(400), 10, 10), /No encontramos/)
})

test('image import rejects active/unsupported formats and oversized files before decoding', async () => {
  for (const file of [{ type: 'image/svg+xml', size: 20 }, { type: 'image/png', size: MAX_QR_IMAGE_BYTES + 1 }, { type: 'image/png', size: 0 }]) {
    await assert.rejects(readQRImage(file), /PNG, JPEG o WebP de hasta 5 MiB/)
  }
})

test('black screenshots fail closed and images above the 16 MP source cap are rejected', async t => {
  const black = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) }
  installCanvasMocks(t, black)
  await assert.rejects(readQRImage({ type: 'image/png', size: 100 }), /No encontramos un QR válido/)
  globalThis.createImageBitmap = async () => ({ width: 4097, height: 4097, close() {} })
  await assert.rejects(readQRImage({ type: 'image/png', size: 100 }), /16 megapíxeles/)
})
