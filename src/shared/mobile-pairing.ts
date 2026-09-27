const pairingCodePattern = /^[0-9A-F]{16}$/

export function mobilePairingURL(origin: string, code: string): string {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || !pairingCodePattern.test(code)) throw new Error('Enlace móvil inválido.')
  url.hash = new URLSearchParams({ pair: code }).toString()
  return url.toString()
}

export function pairingCodeFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, '')).get('pair')
  return code && pairingCodePattern.test(code) ? code : null
}
