import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AlertSound {
  name: string
  dataBase64: string
}

export const MAX_ALERT_SOUND_BYTES = 5 * 1024 * 1024

export function validateAlertSound(value: AlertSound): Buffer {
  if (!value || typeof value.name !== 'string' || !/^[^\\/\x00-\x1f]{1,120}\.(mp3|wav|ogg)$/i.test(value.name)) {
    throw new Error('Elegí un archivo MP3, WAV u OGG válido.')
  }
  if (typeof value.dataBase64 !== 'string' || value.dataBase64.length === 0 || value.dataBase64.length > Math.ceil(MAX_ALERT_SOUND_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.dataBase64)) {
    throw new Error('El sonido debe ocupar 5 MB como máximo.')
  }
  const bytes = Buffer.from(value.dataBase64, 'base64')
  if (!bytes.length || bytes.length > MAX_ALERT_SOUND_BYTES || bytes.toString('base64') !== value.dataBase64) {
    throw new Error('El archivo de sonido no es válido o supera 5 MB.')
  }
  return bytes
}

export class AlertSoundStore {
  private readonly path: string

  constructor(directory: string) {
    this.path = join(directory, 'alert-sound.json')
  }

  load(): AlertSound | null {
    if (!existsSync(this.path)) return null
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as AlertSound
    validateAlertSound(value)
    return value
  }

  save(value: AlertSound): void {
    validateAlertSound(value)
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(value))
      renameSync(temp, this.path)
    } finally {
      if (existsSync(temp)) rmSync(temp)
    }
  }

  clear(): void {
    rmSync(this.path, { force: true })
  }
}
