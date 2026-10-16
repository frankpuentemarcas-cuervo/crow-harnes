/**
 * xterm's alternate buffer is intentionally screen-only and has no scrollback.
 * Keep this check shared with the native terminal UI and its behavioral tests.
 */
export function hasScrollableHistory(buffer) {
  return buffer?.type === 'normal' && Number.isFinite(buffer.baseY) && buffer.baseY > 0
}
