import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AlertAIInput, AlertAISettings } from '../shared/types'
import { DEFAULT_AI_URL, validateAIBaseURL, type AIConfiguration } from './attention-classifier.ts'

export interface SecretEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
interface SettingsFile { enabled: boolean; autoOpenFreeLLM: boolean; baseURL: string; model: string; encryptedKey: string }
const defaults = (): SettingsFile => ({ enabled: false, autoOpenFreeLLM: true, baseURL: DEFAULT_AI_URL, model: 'auto', encryptedKey: '' })

function validateModel(value: string): string {
  if (typeof value !== 'string' || !/^[\w.:/+-]{1,120}$/.test(value.trim())) throw new Error('Ingresá un modelo válido, por ejemplo auto o auto:fast.')
  return value.trim()
}

export class AlertAISettingsStore {
  private readonly path: string
  private data: SettingsFile
  private readonly encryption: SecretEncryption
  private configurationError?: string

  constructor(directory: string, encryption: SecretEncryption) {
    this.encryption = encryption
    this.path = join(directory, 'alert-ai.json')
    // Do not silently erase a corrupted file or enable remote inference by default.
    this.data = defaults()
    try {
      if (existsSync(this.path)) {
        const value = JSON.parse(readFileSync(this.path, 'utf8'))
        if (typeof value.enabled !== 'boolean' || typeof value.encryptedKey !== 'string') throw new Error('La configuración de Free LLM está dañada.')
        if (value.autoOpenFreeLLM !== undefined && typeof value.autoOpenFreeLLM !== 'boolean') throw new Error('Preferencia de inicio inválida.')
        this.data = { enabled: value.enabled, autoOpenFreeLLM: value.autoOpenFreeLLM ?? true, baseURL: validateAIBaseURL(value.baseURL), model: validateModel(value.model), encryptedKey: value.encryptedKey }
      }
    } catch { this.configurationError = 'No se pudo leer la configuración guardada de Free LLM. Volvé a configurarla; el archivo original no se borró.' }
  }

  snapshot(): AlertAISettings {
    const { encryptedKey, ...settings } = this.data
    return { ...settings, keyPresent: !!encryptedKey, secureStorageAvailable: this.encryption.isEncryptionAvailable(), configurationError: this.configurationError }
  }

  configuration(): AIConfiguration {
    if (!this.data.encryptedKey || !this.encryption.isEncryptionAvailable()) throw new Error('Configurá la clave de Free LLM en el almacenamiento seguro de Windows.')
    try {
      return { baseURL: this.data.baseURL, model: this.data.model, apiKey: this.encryption.decryptString(Buffer.from(this.data.encryptedKey, 'base64')) }
    } catch { throw new Error('No se pudo desbloquear la clave de Free LLM; volvé a ingresarla.') }
  }

  save(input: AlertAIInput): AlertAISettings {
    if (!input || typeof input.enabled !== 'boolean' || (input.removeKey !== undefined && typeof input.removeKey !== 'boolean')) throw new Error('Configuración de alertas inválida.')
    if (input.autoOpenFreeLLM !== undefined && typeof input.autoOpenFreeLLM !== 'boolean') throw new Error('Preferencia de inicio inválida.')
    const next: SettingsFile = { enabled: input.enabled, autoOpenFreeLLM: input.autoOpenFreeLLM ?? this.data.autoOpenFreeLLM, baseURL: validateAIBaseURL(input.baseURL), model: validateModel(input.model), encryptedKey: input.removeKey ? '' : this.data.encryptedKey }
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new Error('La clave de Free LLM no es válida.')
      if (input.removeKey && input.apiKey.trim()) throw new Error('No podés eliminar y guardar una clave nueva a la vez.')
      if (input.apiKey.trim()) {
        if (!this.encryption.isEncryptionAvailable()) throw new Error('No está disponible el almacenamiento seguro de Windows.')
        next.encryptedKey = this.encryption.encryptString(input.apiKey.trim()).toString('base64')
      }
    }
    if (next.enabled && (!next.encryptedKey || !this.encryption.isEncryptionAvailable())) throw new Error('Guardá una clave segura antes de activar la clasificación por IA.')
    // Never carry a credential silently to another local application/port.
    if (next.baseURL !== this.data.baseURL && next.encryptedKey && !input.apiKey?.trim() && !input.removeKey) throw new Error('Si cambiás la URL, volvé a ingresar la clave correspondiente.')
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    try { writeFileSync(temp, JSON.stringify(next), { mode: 0o600 }); renameSync(temp, this.path) }
    finally { rmSync(temp, { force: true }) }
    this.data = next
    this.configurationError = undefined
    return this.snapshot()
  }
}
