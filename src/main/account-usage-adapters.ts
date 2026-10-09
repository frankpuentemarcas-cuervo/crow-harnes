import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, stat, lstat, open } from 'node:fs/promises'
import { delimiter, join, resolve, sep } from 'node:path'
import type { UsageWindow } from '../shared/account-usage'

export type AccountUsageErrorCode = 'signed-out' | 'unsupported' | 'error' | 'rate-limited'
export class AccountUsageError extends Error {
  readonly code: AccountUsageErrorCode
  readonly retryAt?: number
  constructor(code: AccountUsageErrorCode, retryAt?: number) {
    super({ 'signed-out': 'Iniciá sesión nuevamente.', unsupported: 'Proveedor o CLI no compatible. Instalá o actualizá el CLI oficial.', error: 'No se pudo consultar el proveedor.', 'rate-limited': 'El proveedor limitó las consultas. Intentá más tarde.' }[code])
    this.code = code
    this.retryAt = retryAt
  }
}
export interface AccountUsageAdapter {
  login(profileDir: string): Promise<void>
  usage(profileDir: string): Promise<{ identity?: string; windows: UsageWindow[] }>
  dispose?(): void
}
type Obj = Record<string, unknown>
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const failure = (): never => { throw new AccountUsageError('unsupported') }
const malformed = (): never => { throw new AccountUsageError('error') }
const bounded = (v: unknown, max: number): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined
const reset = (v: unknown): number | undefined => bounded(v, 8_640_000_000_000_000)
const safeText = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 120 && !/[\x00-\x1f\x7f]/.test(v) ? v : undefined
const windowLabel = (minutes: unknown, slot: string): string => minutes === 300 ? '5 horas' : minutes === 10080 ? 'Semanal' : typeof minutes === 'number' && minutes > 0 ? `${minutes} minutos` : slot === 'primary' ? 'Principal' : 'Secundaria'

export function parseCodexUsage(value: unknown): UsageWindow[] {
  const response = object(value)
  const mapped = object(response.rateLimitsByLimitId)
  const buckets = Object.keys(mapped).length ? Object.entries(mapped).slice(0, 12) : [['codex', response.rateLimits]]
  const windows: UsageWindow[] = []
  for (const [key, value] of buckets) {
    const bucket = object(value)
    for (const slot of ['primary', 'secondary']) {
      if (bucket[slot] == null) continue
      const window = object(bucket[slot])
      const usedPercent = bounded(window.usedPercent, 100)
      if (usedPercent === undefined) malformed()
      const rawReset = window.resetsAt
      if (rawReset != null && (bounded(rawReset, 8_640_000_000_000) === undefined || !Number.isInteger(rawReset))) malformed()
      const minutes = window.windowDurationMins
      if (minutes != null && (bounded(minutes, 525_600) === undefined || !Number.isInteger(minutes))) malformed()
      windows.push({ id: `${safeText(key) ?? 'codex'}:${slot}`, label: `${safeText(bucket.limitName) ?? safeText(key) ?? 'Codex'} · ${windowLabel(minutes, slot)}`, usedPercent: usedPercent!, ...(rawReset == null ? {} : { resetsAt: Number(rawReset) * 1000 }), ...(minutes == null ? {} : { windowMinutes: Number(minutes) }) })
    }
  }
  if (!windows.length) failure()
  return windows
}
export function parseClaudeUsage(value: unknown): UsageWindow[] {
  const response = object(value)
  const windows: UsageWindow[] = []
  for (const [id, label, minutes] of [['five_hour', 'Sesión (5 horas)', 300], ['seven_day', 'Semanal', 10080], ['seven_day_opus', 'Semanal Opus', 10080], ['seven_day_sonnet', 'Semanal Sonnet', 10080]] as const) {
    if (response[id] == null) continue
    const window = object(response[id])
    const usedPercent = bounded(window.utilization, 100)
    if (usedPercent === undefined) malformed()
    let resetsAt: number | undefined
    if (window.resets_at != null) {
      if (typeof window.resets_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(window.resets_at)) malformed()
      resetsAt = reset(Date.parse(window.resets_at as string))
      if (resetsAt === undefined) malformed()
    }
    windows.push({ id, label, usedPercent: usedPercent!, windowMinutes: minutes, ...(resetsAt === undefined ? {} : { resetsAt }) })
  }
  if (!windows.length) failure()
  return windows
}
export function validateCodexAuthURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16384) failure()
  let url: URL
  try { url = new URL(value as string) } catch { return failure() }
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) failure()
  return url.href
}

// Only ordinary operating-system variables survive: never inherit API keys,
// alternate backend URLs, OAuth tokens or provider configuration overrides.
export function accountUsageEnvironment(provider: 'codex' | 'claude', profileDir: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) if (/^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|home|localappdata|appdata|programfiles|programfiles\(x86\))$/i.test(key)) env[key] = value
  env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = resolve(profileDir)
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
type Executable = { file: string; args: string[] }
async function exists(file: string): Promise<boolean> { try { return (await stat(file)).isFile() } catch { return false } }
export async function resolveAccountCLI(provider: 'codex' | 'claude', pathValue = process.env.PATH ?? process.env.Path ?? ''): Promise<Executable> {
  const paths = pathValue.split(delimiter).filter(Boolean)
  // Prefer a native binary. Never run .cmd via a shell or parse arbitrary shim text.
  for (const dir of paths) {
    const file = resolve(dir, process.platform === 'win32' ? `${provider}.exe` : provider)
    if (await exists(file)) return { file, args: [] }
  }
  if (process.platform === 'win32') for (const dir of paths) {
    const root = resolve(dir, 'node_modules', provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code')
    try {
      const pkg = object(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
      if (pkg.name !== (provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code')) continue
      const bin = object(pkg.bin)[provider]
      if (typeof bin !== 'string') continue
      const script = resolve(root, bin)
      if (!script.startsWith(root + sep) || !script.endsWith('.js') || !await exists(script)) continue
      return { file: process.execPath, args: [script] }
    } catch { /* Not a supported npm installation. */ }
  }
  return failure()
}
interface AdapterDependencies {
  resolveCLI?: typeof resolveAccountCLI
  spawn?: typeof spawn
  readFile?: typeof readFile
  fetch?: typeof fetch
  openExternal?: (url: string) => Promise<void>
}

export async function readClaudeProfileCredentials(file: string): Promise<string> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) failure()
  const handle = await open(file, 'r')
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.size > 65536 || actual.ino !== info.ino || actual.dev !== info.dev) failure()
    const buffer = Buffer.alloc(65537)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 65536) failure()
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
}

class CodexRPC {
  private sequence = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private buffer = ''
  private loginEvents: Obj[] = []
  private waitLogin?: (v: Obj) => void
  private rejectLogin?: () => void
  private closed = false
  readonly child: ChildProcessWithoutNullStreams
  private terminate: (child: ChildProcessWithoutNullStreams) => void
  constructor(child: ChildProcessWithoutNullStreams, terminate: (child: ChildProcessWithoutNullStreams) => void) {
    this.child = child
    this.terminate = terminate
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > 1_048_576) return this.close()
      let lineEnd: number
      while ((lineEnd = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, lineEnd); this.buffer = this.buffer.slice(lineEnd + 1)
        let message: Obj
        try { message = object(JSON.parse(line)) } catch { this.close(); return }
        if (typeof message.id === 'number' && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id)!; this.pending.delete(message.id); clearTimeout(pending.timer)
          if (message.error) pending.reject(new AccountUsageError(object(message.error).code === -32601 ? 'unsupported' : 'error'))
          else pending.resolve(message.result)
        } else if (message.method === 'account/login/completed') {
          const params = object(message.params)
          if (this.waitLogin) this.waitLogin(params)
          else if (this.loginEvents.length < 4) this.loginEvents.push(params)
        } else if (message.id != null && message.method) {
          child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n')
        }
      }
    })
    child.stderr.resume() // Never retain/log raw provider failures or credentials.
    child.on('error', () => this.close()); child.on('exit', () => this.close())
    child.stdin.on('error', () => this.close())
  }
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new AccountUsageError('error'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AccountUsageError('error')) }, 20_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n')
    })
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'crow_harness_usage', title: 'Crow Harness', version: '1.0.0' } })
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  }
  async login(loginId: unknown): Promise<void> {
    if (this.closed) throw new AccountUsageError('error')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.waitLogin = undefined; this.rejectLogin = undefined; reject(new AccountUsageError('error')) }, 300_000)
      this.rejectLogin = () => { clearTimeout(timer); this.waitLogin = undefined; reject(new AccountUsageError('error')) }
      this.waitLogin = params => {
        if (params.loginId !== loginId) return
        clearTimeout(timer); this.waitLogin = undefined; this.rejectLogin = undefined
        if (params.success === true) resolve(); else reject(new AccountUsageError('signed-out'))
      }
      for (const event of this.loginEvents) this.waitLogin?.(event)
      this.loginEvents = []
    })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AccountUsageError('error')) }
    this.pending.clear(); this.rejectLogin?.(); this.rejectLogin = undefined; this.terminate(this.child)
  }
}

export function createAccountUsageAdapters(deps: AdapterDependencies = {}): Record<'codex' | 'claude', AccountUsageAdapter> {
  const run = deps.spawn ?? spawn, cli = deps.resolveCLI ?? resolveAccountCLI, read = deps.readFile ?? readFile, request = deps.fetch ?? fetch
  const children = new Set<ChildProcessWithoutNullStreams>()
  let disposed = false
  const requests = new Set<AbortController>()
  const active = (): void => { if (disposed) throw new AccountUsageError('error') }
  const terminate = (child: ChildProcessWithoutNullStreams): void => {
    if (process.platform === 'win32' && child.pid && Number.isSafeInteger(child.pid)) {
      const killer = run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => { child.kill() })
    } else child.kill()
  }
  const start = async (provider: 'codex' | 'claude', profile: string, args: string[]): Promise<ChildProcessWithoutNullStreams> => {
    active()
    const command = await cli(provider)
    active()
    const child = run(command.file, [...command.args, ...args], { cwd: resolve(profile), env: accountUsageEnvironment(provider, profile), windowsHide: true, stdio: 'pipe' }) as ChildProcessWithoutNullStreams
    children.add(child); child.on('exit', () => children.delete(child))
    return child
  }
  const codex = async (profile: string, task: (rpc: CodexRPC) => Promise<unknown>): Promise<unknown> => {
    const child = await start('codex', profile, ['-c', 'cli_auth_credentials_store="file"', 'app-server'])
    const rpc = new CodexRPC(child, terminate)
    try { await rpc.initialize(); return await task(rpc) } catch (e) { throw e instanceof AccountUsageError ? e : new AccountUsageError('error') } finally { rpc.close(); children.delete(child) }
  }
  const dispose = (): void => { disposed = true; for (const request of requests) request.abort(); requests.clear(); for (const child of children) terminate(child); children.clear() }
  return {
    codex: {
      async login(profile) {
        await codex(profile, async rpc => {
          const result = object(await rpc.request('account/login/start', { type: 'chatgpt' }))
          if (result.type !== 'chatgpt' || typeof result.loginId !== 'string') failure()
          const url = validateCodexAuthURL(result.authUrl)
          const open = deps.openExternal ?? (async (url: string) => { const { shell } = await import('electron'); active(); await shell.openExternal(url) })
          active(); await open(url); active(); await rpc.login(result.loginId)
        })
      },
      async usage(profile) {
        return await codex(profile, async rpc => {
          const account = object(object(await rpc.request('account/read', { refreshToken: true })).account)
          if (!account.type) throw new AccountUsageError('signed-out')
          if (account.type !== 'chatgpt') failure()
          return { identity: safeText(account.email), windows: parseCodexUsage(await rpc.request('account/rateLimits/read')) }
        }) as { identity?: string; windows: UsageWindow[] }
      },
      dispose
    },
    claude: {
      async login(profile) {
        active()
        if (process.platform !== 'win32') failure()
        const command = await cli('claude')
        active()
        const env = accountUsageEnvironment('claude', profile)
        env.CROW_USAGE_EXECUTABLE = command.file
        env.CROW_USAGE_ARGS = JSON.stringify([...command.args, 'auth', 'login'])
        // Explicit interactive sign-in window; command and arguments travel as
        // environment data, never interpolated into a shell command.
        const script = '$a = @(ConvertFrom-Json $env:CROW_USAGE_ARGS); & $env:CROW_USAGE_EXECUTABLE @a; exit $LASTEXITCODE'
        env.CROW_USAGE_LOGIN_SCRIPT = Buffer.from(script, 'utf16le').toString('base64')
        // The inner process owns a real console (not redirected stdin); the
        // hidden supervisor captures only its exit code, never login output.
        const launch = '$p = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList @("-NoProfile", "-EncodedCommand", $env:CROW_USAGE_LOGIN_SCRIPT) -WindowStyle Normal -Wait -PassThru; exit $p.ExitCode'
        const child = run(join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')], { cwd: resolve(profile), env, windowsHide: true, stdio: 'pipe' }) as ChildProcessWithoutNullStreams
        children.add(child); child.stdout.resume(); child.stderr.resume()
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { terminate(child); reject(new AccountUsageError('error')) }, 300_000)
          child.once('error', () => { clearTimeout(timer); children.delete(child); reject(new AccountUsageError('unsupported')) })
          child.once('exit', code => { clearTimeout(timer); children.delete(child); if (code === 0) resolve(); else reject(new AccountUsageError('signed-out')) })
        })
      },
      async usage(profile) {
        active()
        let token: string
        try {
          const file = join(resolve(profile), '.credentials.json')
          const raw = deps.readFile ? await read(file, 'utf8') : await readClaudeProfileCredentials(file)
          if (String(raw).length > 65536) failure()
          const auth = object(object(JSON.parse(String(raw))).claudeAiOauth)
          if (typeof auth.accessToken !== 'string' || auth.accessToken.length > 16384 || !auth.accessToken || /[\r\n]/.test(auth.accessToken)) throw new AccountUsageError('signed-out')
          if (typeof auth.expiresAt === 'number' && auth.expiresAt <= Date.now()) throw new AccountUsageError('signed-out')
          token = auth.accessToken
        } catch (e) { throw e instanceof AccountUsageError ? e : new AccountUsageError('signed-out') }
        active()
        const controller = new AbortController(); requests.add(controller)
        try {
          const response = await request('https://api.anthropic.com/api/oauth/usage', { method: 'GET', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' } })
          active()
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined)
            if (response.status === 401) throw new AccountUsageError('signed-out')
            if (response.status === 429) {
              const header = response.headers.get('retry-after')
              const seconds = header == null ? NaN : Number(header)
              const requestedAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(header ?? '')
              throw new AccountUsageError('rate-limited', Math.max(Date.now() + 300_000, Number.isFinite(requestedAt) ? Math.min(requestedAt, Date.now() + 7 * 86400_000) : 0))
            }
            throw new AccountUsageError(response.status === 403 || response.status === 404 ? 'unsupported' : 'error')
          }
          if (!response.body) failure()
          const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0
          try {
            while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 65536) failure(); chunks.push(result.value) }
          } finally { await reader.cancel().catch(() => undefined) }
          return { windows: parseClaudeUsage(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        } catch (e) { throw e instanceof AccountUsageError ? e : new AccountUsageError('error') } finally { requests.delete(controller) }
      },
      dispose
    }
  }
}
