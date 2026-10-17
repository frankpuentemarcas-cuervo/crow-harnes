import jsQR from 'jsqr'

export const MAX_QR_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_QR_PIXELS = 4 * 1024 * 1024
const MAX_UPSCALE_SOURCE_PIXELS = 1024 * 1024

export function decodeQRFrame(data, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_QR_PIXELS || data.length !== width * height * 4) throw new Error('La imagen del QR tiene dimensiones inválidas o es demasiado grande.')
  const code = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })
  if (!code?.data || code.data.length > 32768) throw new Error('No encontramos un QR válido. Recortá la imagen para que se vea completo, con su borde.')
  return code.data
}

function lightPanelBounds(data, width, height) {
  const bounds = axis => {
    const length = axis === 'x' ? width : height, cross = axis === 'x' ? height : width
    let first = -1, last = -1
    for (let i = 0; i < length; i++) {
      let light = 0
      for (let j = 0; j < cross; j++) {
        const offset = (axis === 'x' ? j * width + i : i * width + j) * 4
        if (data[offset] > 220 && data[offset + 1] > 220 && data[offset + 2] > 220) light++
      }
      if (light / cross >= 0.25) { if (first < 0) first = i; last = i }
    }
    return first < 0 ? null : [first, last + 1]
  }
  const x = bounds('x'), y = bounds('y')
  if (!x || !y) return null
  const [left, right] = x, [top, bottom] = y
  const w = right - left, h = bottom - top
  // The card must be substantial and approximately square; avoid treating light UI text as a panel.
  if (w < 96 || h < 96 || Math.max(w, h) / Math.min(w, h) > 1.25) return null
  return { x: Math.max(0, left - 2), y: Math.max(0, top - 2), width: Math.min(width - left + 2, w + 4), height: Math.min(height - top + 2, h + 4) }
}

/** Decode offline, then pass to the SAME enrollment validation/consent as camera. */
export async function readQRImage(file, decodeFrame = decodeQRFrame) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size < 1 || file.size > MAX_QR_IMAGE_BYTES) throw new Error('Usá una imagen PNG, JPEG o WebP de hasta 5 MiB.')
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16 * 1024 * 1024) throw new Error('La imagen supera 16 megapíxeles. Recortá solamente el QR.')
    const scale = Math.min(1, Math.sqrt(MAX_QR_PIXELS / (bitmap.width * bitmap.height)))
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale)); canvas.height = Math.max(1, Math.floor(bitmap.height * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('No se pudo leer la imagen del QR.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const frame = context.getImageData(0, 0, canvas.width, canvas.height).data
    let failure
    try { return decodeFrame(frame, canvas.width, canvas.height) } catch (error) { failure = error }

    const crop = lightPanelBounds(frame, canvas.width, canvas.height)
    if (!crop) throw failure
    const croppedCanvas = document.createElement('canvas')
    croppedCanvas.width = crop.width; croppedCanvas.height = crop.height
    const cropped = croppedCanvas.getContext('2d', { willReadFrequently: true })
    if (!cropped) { croppedCanvas.width = 0; croppedCanvas.height = 0; throw failure }
    try {
      cropped.drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
      const cropPixels = cropped.getImageData(0, 0, crop.width, crop.height).data
      try { return decodeFrame(cropPixels, crop.width, crop.height) } catch { /* bounded 2x retry below */ }
      // Doubling stays within the existing 4 MP decoder bound: only crop regions <= 1 MP qualify.
      if (crop.width * crop.height > MAX_UPSCALE_SOURCE_PIXELS) throw failure
      const doubled = document.createElement('canvas')
      doubled.width = crop.width * 2; doubled.height = crop.height * 2
      const enlarged = doubled.getContext('2d', { willReadFrequently: true })
      if (!enlarged) { doubled.width = 0; doubled.height = 0; throw failure }
      enlarged.imageSmoothingEnabled = false
      try {
        enlarged.drawImage(croppedCanvas, 0, 0, crop.width * 2, crop.height * 2)
        return decodeFrame(enlarged.getImageData(0, 0, crop.width * 2, crop.height * 2).data, crop.width * 2, crop.height * 2)
      } catch { throw failure }
      finally { doubled.width = 0; doubled.height = 0 }
    } finally { croppedCanvas.width = 0; croppedCanvas.height = 0 }
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0 }
}
