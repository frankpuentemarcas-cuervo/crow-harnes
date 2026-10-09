export type AccountProvider = 'claude' | 'codex'
export type AccountUsageStatus = 'signed-out' | 'ready' | 'stale' | 'error' | 'signing-in' | 'unsupported' | 'rate-limited'

export interface AccountUsageWindow {
  id: string
  label: string
  usedPercent: number
  resetsAt?: number
  windowMinutes?: number
}
export type UsageWindow = AccountUsageWindow

/** Safe renderer DTO: credentials and profile paths remain in the main process. */
export interface AccountUsage {
  id: string
  provider: AccountProvider
  label: string
  status: AccountUsageStatus
  identity?: string
  windows: AccountUsageWindow[]
  updatedAt?: number
  error?: string
  retryAt?: number
}

export interface AccountUsageAPI {
  accountsList(): Promise<AccountUsage[]>
  accountsAdd(input: { provider: AccountProvider; label: string }): Promise<AccountUsage>
  accountsLogin(id: string): Promise<AccountUsage>
  accountsRefresh(id: string): Promise<AccountUsage>
  accountsRemove(id: string): Promise<void>
}
