/** CSS size per QR module mapped to an integer physical-pixel grid at current DPI. */
export function mobileQrModulePixels(moduleCount: number, width: number, height: number, scanMode: boolean, devicePixelRatio = 1): number {
  if (!Number.isInteger(moduleCount) || moduleCount < 1) return 1
  const available = scanMode
    ? Math.min(width - 32, 922, height - 190) * Math.max(1, devicePixelRatio)
    : Math.min(width * 0.82, height * 0.48)
  // Scan mode aligns module edges to physical display pixels (even at fractional
  // Windows scale factors) and keeps a two-device-pixel minimum for dense codes.
  const modulePhysicalPixels = Math.max(scanMode ? 2 : 1, Math.floor(available / (moduleCount + 8)))
  return scanMode ? modulePhysicalPixels / Math.max(1, devicePixelRatio) : modulePhysicalPixels
}
