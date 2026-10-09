import type { ConnectionStatus } from './types'

export interface FreeLLMRuntimeStatus { state: 'idle' | 'disabled' | 'checking' | 'available' | 'unavailable'; detail: string }

export function freeLLMStartupReady(input: { loaded: boolean; enabled: boolean; busy: boolean; pending: number; hostIds: string[]; statuses: Record<string, ConnectionStatus> }): boolean {
  return input.loaded && input.enabled && !input.busy && input.pending === 0 && input.hostIds.every(id => input.statuses[id] && input.statuses[id] !== 'connecting')
}
