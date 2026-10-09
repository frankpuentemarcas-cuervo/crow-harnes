let context: AudioContext | undefined

function audioContext(): AudioContext {
  if (!context || context.state === 'closed') context = new AudioContext()
  return context
}

export async function decodeCompletionSound(dataBase64: string): Promise<AudioBuffer> {
  const binary = atob(dataBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const decoded = await audioContext().decodeAudioData(bytes.buffer)
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 30) throw new Error('El sonido debe durar como máximo 30 segundos y no estar vacío.')
  return decoded
}

export function isFreshNotice(at: string, now = Date.now()): boolean {
  const age = now - Date.parse(at)
  return Number.isFinite(age) && age >= -60_000 && age <= 120_000
}

export async function playCompletionSound(custom?: AudioBuffer | null, onEnded?: () => void): Promise<void> {
  const current = audioContext()
  if (current.state === 'suspended') await current.resume()
  if (current.state !== 'running') throw new Error('El dispositivo de audio no está disponible.')

  const start = current.currentTime + 0.02
  if (custom) {
    const source = current.createBufferSource()
    source.buffer = custom
    source.connect(current.destination)
    if (onEnded) source.onended = onEnded
    source.start(start)
    return
  }
  for (const [offset, frequency] of [[0, 660], [0.18, 880]] as const) {
    const oscillator = current.createOscillator()
    const gain = current.createGain()
    const at = start + offset
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, at)
    gain.gain.setValueAtTime(0.001, at)
    gain.gain.linearRampToValueAtTime(0.17, at + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.17)
    oscillator.connect(gain).connect(current.destination)
    if (offset === 0.18 && onEnded) oscillator.onended = onEnded
    oscillator.start(at)
    oscillator.stop(at + 0.18)
  }
}
