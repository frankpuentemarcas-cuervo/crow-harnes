import { createElement } from 'react'

const device = { id: 'device', label: 'Mi Android', pairedAt: new Date().toISOString(), expiresAt: null, projectIds: ['project'], capabilities: { input: true, create: false, close: false, quotas: false } }
const profiles = ['windows', 'factory'].map(id => ({ id, gatewayId: `gateway-${id}`, mobileHostId: id, endpoint: { kind: 'relay', url: 'https://127.0.0.1:47321' }, device: { ...device, label: id === 'windows' ? 'Crow Windows' : 'FACTORY' } }))
const listeners = new Map<string, Set<(value?: any) => void>>()
const counts = { windows: 0, factory: 0, sessions: 0, cancelled: 0, writes: 0, pairs: 0 }
const held = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; value: unknown }>()
let hold = '', failure = ''
export const Capacitor = { isNativePlatform: () => true }
export const App = { addListener: async (event: string, fn: (value?: any) => void) => { const set = listeners.get(event) || new Set(); set.add(fn); listeners.set(event, set); return { remove: async () => { set.delete(fn) } } }, minimizeApp: async () => {} }
export const CapacitorBarcodeScanner = {}
const gateway = {
  pair: async () => { counts.pairs++; return { profile: profiles[0] } },
  listProfiles: async () => ({ profiles }),
  request: async ({ profileId, path, method, readId }: { profileId: 'windows' | 'factory'; path: string; method: string; readId?: string }) => {
    if (method !== 'GET') counts.writes++
    const profile = profiles.find(item => item.id === profileId)!
    if (path === '/api/v1/bootstrap') {
      counts[profileId]++
      if (failure && profileId === 'windows') throw new Error(failure)
      const value = { data: { version: 1, device: { ...profile.device }, hosts: [{ id: 'factory', name: 'FACTORY', status: 'connected' }], projects: [{ id: 'project', hostId: 'factory', name: 'SOMA' }] } }
      if (hold === profileId) return new Promise((resolve, reject) => held.set(readId || String(Math.random()), { resolve, reject, value }))
      await new Promise(resolve => setTimeout(resolve, 5)); return value
    }
    if (path.startsWith('/api/v1/sessions?')) { counts.sessions++; return { data: [{ id: 'session', hostId: 'factory', projectId: 'project', agent: 'claude', name: 'Eric · SOMA', state: 'running', agentState: 'unknown', chatAvailable: true, canOperate: true }] } }
    return { data: [] }
  },
  cancelRead: async ({ readId }: { readId: string }) => { counts.cancelled++; const request = held.get(readId); held.delete(readId); request?.reject(new Error('read cancelled')) },
  addListener: async () => ({ remove: async () => {} }),
}
export const registerPlugin = () => gateway
export function TerminalView({ profile, initialDiagnostics }: any) { return createElement('div', { className: 'qa-terminal', 'data-profile': profile.id, 'data-diagnostics': !!initialDiagnostics }, 'Terminal autorizada') }
export const ChatView = TerminalView
;(window as any).__connectionQA = {
  counts, hold: (id: string) => { hold = id }, fail: (value: string) => { failure = value },
  release: () => { for (const request of held.values()) request.resolve(request.value); held.clear() },
  foreground: () => { for (const fn of listeners.get('appStateChange') || []) fn({ isActive: true }) },
  back: () => { for (const fn of listeners.get('backButton') || []) fn() },
}
