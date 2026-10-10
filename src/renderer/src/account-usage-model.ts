import type { AccountProvider, AccountUsage, AccountUsageAPI, AccountUsageWindow } from '../../shared/account-usage'

export const ACCOUNT_USAGE_REFRESH_MS = 180_000
const CLOCK_MS = 30_000
const OPERATION_ERROR = 'No se pudo completar la operación. Revisá la conexión y volvé a intentarlo.'

export interface AccountUsageSnapshot {
  accounts: AccountUsage[]
  loading: boolean
  busy: string
  error: string
  now: number
}

export interface AccountUsageEnvironment {
  now(): number
  visible(): boolean
  setTimer(callback: () => void, delay: number): unknown
  clearTimer(timer: unknown): void
  onVisibility(callback: () => void): () => void
}

export function quotaSampleIsStale(account: AccountUsage, now: number): boolean {
  return account.status !== 'ready' || account.updatedAt === undefined || now - account.updatedAt >= ACCOUNT_USAGE_REFRESH_MS
}

export function quotaWindowIsStale(account: AccountUsage, window: AccountUsageWindow, now: number): boolean {
  return quotaSampleIsStale(account, now) || (window.resetsAt !== undefined && now >= window.resetsAt)
}

/** App-owned lifecycle: consumers subscribe to a snapshot, never create pollers. */
export class AccountUsageController {
  private state: AccountUsageSnapshot
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private running = false
  private timer: unknown
  private unsubscribeVisibility?: () => void
  private tail: Promise<unknown> = Promise.resolve()
  private polling = false
  private userPending = false
  private nextPollAt = 0
  private readonly attempts = new Map<string, number>()
  private readonly api: AccountUsageAPI
  private readonly environment: AccountUsageEnvironment

  constructor(api: AccountUsageAPI, environment: AccountUsageEnvironment) {
    this.api = api
    this.environment = environment
    this.state = { accounts: [], loading: true, busy: '', error: '', now: environment.now() }
  }

  getSnapshot = (): AccountUsageSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  clearError = (): void => { this.publish({ error: '' }) }

  private current(generation: number): boolean { return this.running && this.generation === generation }
  private publish(patch: Partial<AccountUsageSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private update(account: AccountUsage): void {
    this.publish({ accounts: this.state.accounts.some(item => item.id === account.id)
      ? this.state.accounts.map(item => item.id === account.id ? account : item)
      : [...this.state.accounts, account] })
  }

  start = (): (() => void) => {
    if (this.running) throw new Error('El seguimiento de cuentas ya está activo.')
    this.running = true
    const generation = ++this.generation
    this.publish({ loading: true, busy: '', now: this.environment.now() })
    this.unsubscribeVisibility = this.environment.onVisibility(() => {
      if (!this.current(generation)) return
      this.publish({ now: this.environment.now() })
      if (this.environment.visible()) void this.poll(generation)
      this.schedule(generation)
    })
    // StrictMode's discarded setup must not issue IPC or occupy the operation queue.
    void Promise.resolve().then(async () => {
      await this.tail
      if (this.current(generation)) void this.poll(generation, true)
    })
    this.schedule(generation)
    return () => {
      if (!this.current(generation)) return
      this.running = false
      this.generation++
      this.environment.clearTimer(this.timer)
      this.timer = undefined
      this.unsubscribeVisibility?.()
      this.unsubscribeVisibility = undefined
    }
  }

  private schedule(generation: number): void {
    this.environment.clearTimer(this.timer)
    this.timer = undefined
    if (!this.current(generation) || !this.environment.visible()) return
    this.timer = this.environment.setTimer(() => {
      this.timer = undefined
      if (!this.current(generation)) return
      this.publish({ now: this.environment.now() })
      void this.poll(generation)
      this.schedule(generation)
    }, CLOCK_MS)
  }

  private eligible(account: AccountUsage): boolean {
    const now = this.environment.now()
    return ['ready', 'stale', 'error', 'rate-limited'].includes(account.status)
      && !(account.retryAt && account.retryAt > now)
      && !(account.status === 'ready' && account.updatedAt !== undefined && now - account.updatedAt < ACCOUNT_USAGE_REFRESH_MS)
      && now >= (this.attempts.get(account.id) || 0)
  }

  private async poll(generation: number, initial = false): Promise<void> {
    if (!this.current(generation) || this.polling || this.userPending || (!initial && (!this.environment.visible() || this.environment.now() < this.nextPollAt))) return
    this.polling = true
    const operation = this.tail.then(async () => {
      if (!this.current(generation)) return
      this.publish({ busy: initial ? 'load' : 'poll' })
      try {
        let batchFailed = false
        const accounts = await this.api.accountsList()
        if (!this.current(generation)) return
        this.publish({ accounts, loading: false })
        if (this.environment.visible()) {
          for (const account of accounts) {
            if (!this.current(generation) || !this.environment.visible()) break
            if (!this.eligible(account)) continue
            this.attempts.set(account.id, this.environment.now() + ACCOUNT_USAGE_REFRESH_MS)
            try {
              const result = await this.api.accountsRefresh(account.id)
              if (!this.current(generation)) return
              this.update(result)
            } catch {
              if (!this.current(generation)) return
              // One IPC/registry failure must not starve unrelated accounts.
              batchFailed = true
              this.publish({ error: OPERATION_ERROR })
            }
          }
          this.nextPollAt = this.environment.now() + ACCOUNT_USAGE_REFRESH_MS
        }
        if (!batchFailed && this.current(generation)) this.publish({ error: '' })
      } catch {
        if (this.current(generation)) {
          this.publish({ error: OPERATION_ERROR })
          this.nextPollAt = this.environment.now() + ACCOUNT_USAGE_REFRESH_MS
        }
      } finally {
        if (this.current(generation)) this.publish({ busy: '', loading: false, now: this.environment.now() })
      }
    })
    this.tail = operation
    try { await operation } finally { this.polling = false }
  }

  private run(key: string, action: (generation: number) => Promise<boolean>): Promise<boolean> {
    if (!this.running || this.userPending) return Promise.resolve(false)
    this.userPending = true
    const generation = this.generation
    const operation = this.tail.then(async () => {
      if (!this.current(generation)) return false
      this.publish({ busy: key, error: '' })
      try {
        const changed = await action(generation)
        return this.current(generation) && changed
      } catch {
        if (this.current(generation)) this.publish({ error: OPERATION_ERROR })
        return false
      } finally {
        if (this.current(generation)) this.publish({ busy: '', now: this.environment.now() })
      }
    })
    this.tail = operation
    return operation.finally(() => { this.userPending = false })
  }

  add = (input: { provider: AccountProvider; label: string }): Promise<boolean> => this.run('add', async generation => {
    const account = await this.api.accountsAdd(input)
    if (this.current(generation)) this.update(account)
    return true
  })
  login = (id: string): Promise<boolean> => this.run(id, async generation => {
    const account = this.state.accounts.find(item => item.id === id)
    if (!account || account.status === 'signing-in') return false
    // Previous identity's sample must not be displayed during reauthentication.
    this.update({ id: account.id, provider: account.provider, label: account.label, status: 'signing-in', windows: [] })
    try {
      const result = await this.api.accountsLogin(id)
      if (this.current(generation)) {
        this.update(result)
        this.attempts.set(id, this.environment.now() + ACCOUNT_USAGE_REFRESH_MS)
      }
      return true
    } catch (error) {
      if (this.current(generation)) this.update({ id: account.id, provider: account.provider, label: account.label, status: 'signed-out', windows: [] })
      throw error
    }
  })
  refresh = (id: string): Promise<boolean> => this.run(id, async generation => {
    const account = this.state.accounts.find(item => item.id === id)
    if (!account || !this.eligible(account)) return false
    this.attempts.set(id, this.environment.now() + ACCOUNT_USAGE_REFRESH_MS)
    const result = await this.api.accountsRefresh(id)
    if (this.current(generation)) this.update(result)
    return true
  })
  remove = (id: string): Promise<boolean> => this.run(id, async generation => {
    const account = this.state.accounts.find(item => item.id === id)
    if (!account || account.status === 'signing-in') return false
    await this.api.accountsRemove(id)
    if (this.current(generation)) {
      this.attempts.delete(id)
      this.publish({ accounts: this.state.accounts.filter(item => item.id !== id) })
    }
    return true
  })
}
