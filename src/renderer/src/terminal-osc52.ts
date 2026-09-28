const MAX_CLIPBOARD_BYTES = 1024 * 1024

export function decodeOsc52Selection(data: string): string | null {
  const separator = data.indexOf(';')
  if (separator < 0) return null

  const target = data.slice(0, separator)
  const encoded = data.slice(separator + 1)
  // Never answer OSC 52 read requests; only stage a write for the user's Copy action.
  if (!/^[cpsq0-7]*$/.test(target) || !encoded || encoded === '?' || encoded.length > Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null

  try {
    const raw = atob(encoded)
    if (raw.length === 0 || raw.length > MAX_CLIPBOARD_BYTES) return null
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) || null
  } catch { return null }
}
