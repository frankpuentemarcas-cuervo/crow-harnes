let context: AudioContext | undefined

export function isFreshNotice(at: string, now = Date.now()): boolean {
  const age = now - Date.parse(at)
  return Number.isFinite(age) && age >= -60_000 && age <= 120_000
}

export async function playCompletionSound(): Promise<void> {
  if (!context || context.state === 'closed') context = new AudioContext()
  if (context.state === 'suspended') await context.resume()
  if (context.state !== 'running') throw new Error('El dispositivo de audio no está disponible.')

  const start = context.currentTime + 0.02
  for (const [offset, frequency] of [[0, 660], [0.18, 880]] as const) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const at = start + offset
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, at)
    gain.gain.setValueAtTime(0.001, at)
    gain.gain.linearRampToValueAtTime(0.17, at + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.17)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(at)
    oscillator.stop(at + 0.18)
  }
}
