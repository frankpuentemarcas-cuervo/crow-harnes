import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AccountUsageAPI } from '../../shared/account-usage'
import { AccountUsageController, type AccountUsageSnapshot } from './account-usage-model'

export type AccountUsageModel = AccountUsageSnapshot & Pick<AccountUsageController, 'add' | 'login' | 'refresh' | 'remove' | 'clearError'>

/** Instantiate once in App; pass its result to the dock and account management. */
export function useAccountUsage(api: AccountUsageAPI = window.crow): AccountUsageModel {
  const controller = useMemo(() => new AccountUsageController(api, {
    now: Date.now,
    visible: () => document.visibilityState !== 'hidden',
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: timer => { if (typeof timer === 'number') window.clearTimeout(timer) },
    onVisibility: callback => {
      document.addEventListener('visibilitychange', callback)
      return () => document.removeEventListener('visibilitychange', callback)
    }
  }), [api])
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => controller.start(), [controller])
  return { ...snapshot, add: controller.add, login: controller.login, refresh: controller.refresh, remove: controller.remove, clearError: controller.clearError }
}
