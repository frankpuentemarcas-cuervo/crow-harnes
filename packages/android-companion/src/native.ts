import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { MobileDevice, MobileEnrollment, MobileEndpoint } from '../../../src/shared/mobile-companion'

export interface GatewayProfile { id: string; gatewayId: string; endpoint: MobileEndpoint; device: MobileDevice }
export interface StreamEvent { connectionId: string; profileId: string; status?: 'connected' | 'disconnected' | 'revoked'; data?: string }
interface NativeGateway {
  pair(input: { enrollment: MobileEnrollment; endpointIndex: number; deviceName: string; fingerprintConfirmed: boolean }): Promise<{ profile: GatewayProfile }>
  listProfiles(): Promise<{ profiles: GatewayProfile[] }>
  deleteProfile(input: { profileId: string }): Promise<void>
  request(input: { profileId: string; path: string; method: 'GET' | 'POST'; body?: unknown }): Promise<{ data: unknown }>
  openStream(input: { profileId: string; hostId: string; sessionId: string; from: number; connectionId: string }): Promise<void>
  send(input: { connectionId: string; type: 'input' | 'resize'; data?: string; cols?: number; rows?: number }): Promise<void>
  closeStream(input: { connectionId: string }): Promise<void>
  addListener(name: 'stream', callback: (event: StreamEvent) => void): Promise<PluginListenerHandle>
}
export const Gateway = registerPlugin<NativeGateway>('CrowGateway')
export async function api<T>(profileId: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  return (await Gateway.request({ profileId, path, method, body })).data as T
}
