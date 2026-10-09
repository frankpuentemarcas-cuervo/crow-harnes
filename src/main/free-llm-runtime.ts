import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { validateAIBaseURL } from './attention-classifier.ts'
import type { FreeLLMRuntimeStatus } from '../shared/free-llm-startup'

interface Settings { enabled: boolean; baseURL: string; autoOpenFreeLLM?: boolean; configurationError?: string }
interface Dependencies { probe?: typeof probeFreeLLM; find?: () => string | undefined; launch?: (path: string) => Promise<void>; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; attempts?: number }

// Availability ONLY: no credentials, prompts, paid requests or model inference.
// 401/403 means the local API is responding, not that authentication is valid.
export async function probeFreeLLM(baseURL: string, cancel?: AbortSignal, request: typeof fetch = fetch): Promise<boolean> {
  const url = validateAIBaseURL(baseURL) + '/models'
  try {
    const response = await request(url, { method: 'GET', redirect: 'error', signal: cancel ? AbortSignal.any([cancel, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) })
    void response.body?.cancel().catch(() => undefined)
    return [200, 401, 403].includes(response.status)
  } catch { return false }
}

export function findFreeLLMExecutable(env: NodeJS.ProcessEnv = process.env, file = (path: string): boolean => { try { return statSync(path).isFile() } catch { return false } }): string | undefined {
  const candidates = [
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'freellmapi-desktop', 'FreeLLMAPI.exe'),
    ...[env.ProgramFiles, env['ProgramFiles(x86)']].flatMap(root => root ? [win32.join(root, 'freellmapi-desktop', 'FreeLLMAPI.exe'), win32.join(root, 'FreeLLMAPI', 'FreeLLMAPI.exe')] : [])
  ]
  return candidates.find((path): path is string => !!path && win32.isAbsolute(path) && !path.startsWith('\\\\') && file(path))
}

export async function launchFreeLLM(executable: string, run: typeof spawn = spawn): Promise<void> {
  if (!/^[a-z]:\\/i.test(win32.normalize(executable)) || win32.basename(executable).toLowerCase() !== 'freellmapi.exe') throw new Error('Instalación de Free LLM no válida.')
  await new Promise<void>((resolve, reject) => {
    const child = run(executable, [], { shell: false, detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => reject(new Error('No se pudo abrir Free LLM API.')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export class FreeLLMRuntime {
  private readonly settings: () => Settings
  private readonly emit: (status: FreeLLMRuntimeStatus) => void
  private readonly deps: Dependencies
  private status: FreeLLMRuntimeStatus = { state: 'idle', detail: 'Pendiente de comprobar Free LLM.' }
  private active?: Promise<FreeLLMRuntimeStatus>
  private controller?: AbortController
  private generation = 0
  private launched = false

  constructor(settings: () => Settings, emit: (status: FreeLLMRuntimeStatus) => void, deps: Dependencies = {}) { this.settings = settings; this.emit = emit; this.deps = deps }
  snapshot(): FreeLLMRuntimeStatus { return { ...this.status } }
  reset(): void { this.generation++; this.controller?.abort(); this.set({ state: 'idle', detail: 'Comprobación cancelada; configuración actualizada.' }) }
  stop(): void { this.generation++; this.controller?.abort() }
  ensure(): Promise<FreeLLMRuntimeStatus> {
    if (this.active) return this.active
    const generation = this.generation
    const controller = this.controller = new AbortController()
    this.active = this.check(generation, controller.signal).catch(() => generation === this.generation ? this.set({ state: 'unavailable', detail: 'No se pudo abrir o comprobar Free LLM API. Abrilo y activá su servidor local.' }) : this.snapshot()).finally(() => { this.active = undefined })
    return this.active
  }
  private set(status: FreeLLMRuntimeStatus): FreeLLMRuntimeStatus { this.status = status; this.emit(this.snapshot()); return this.snapshot() }
  private async check(generation: number, signal: AbortSignal): Promise<FreeLLMRuntimeStatus> {
    const config = this.settings()
    if (!config.enabled) return this.set({ state: 'disabled', detail: 'IA desactivada: no se abrirá Free LLM.' })
    if (config.configurationError) return this.set({ state: 'unavailable', detail: 'Revisá la configuración de Free LLM en Crow.' })
    const url = validateAIBaseURL(config.baseURL)
    const current = (): boolean => generation === this.generation && !signal.aborted
    const probe = this.deps.probe || probeFreeLLM
    const available = (): FreeLLMRuntimeStatus => this.set({ state: 'available', detail: 'La API de Free LLM responde. Validá clave y modelos con Guardar y probar.' })
    this.set({ state: 'checking', detail: 'Comprobando Free LLM API…' })
    const online = await probe(url, signal)
    if (!current()) return this.snapshot()
    if (online) return available()
    if (config.autoOpenFreeLLM === false) return this.set({ state: 'unavailable', detail: 'Free LLM API no responde. Abrilo y activá su servidor local.' })
    if (!this.launched) {
      const executable = (this.deps.find || (() => process.platform === 'win32' ? findFreeLLMExecutable() : undefined))()
      if (!executable) return this.set({ state: 'unavailable', detail: 'No encontré Free LLM API en sus carpetas de instalación habituales. Abrilo manualmente y activá el servidor local.' })
      this.launched = true // At most one process launch per Crow run, including failures.
      this.set({ state: 'checking', detail: 'Abriendo Free LLM API; esperando su servidor local…' })
      await (this.deps.launch || launchFreeLLM)(executable)
    }
    for (let attempt = 0; attempt < (this.deps.attempts ?? 10); attempt++) {
      if (!current()) return this.snapshot()
      await (this.deps.sleep || ((ms, signal) => sleep(ms, undefined, { signal })))(1000, signal)
      const ready = await probe(url, signal)
      if (!current()) return this.snapshot()
      if (ready) return available()
    }
    return this.set({ state: 'unavailable', detail: 'Free LLM se intentó abrir, pero la API todavía no responde. Activá su servidor local y pulsá Comprobar de nuevo.' })
  }
}
