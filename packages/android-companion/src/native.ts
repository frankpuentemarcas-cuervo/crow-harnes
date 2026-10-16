import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { MobileDevice, MobileEnrollment, MobileEndpoint } from '../../../src/shared/mobile-companion'
import { boundedRead } from './connection-read.mjs'

export interface GatewayProfile { id: string; version?: 2; gatewayId: string; mobileHostId?: string; endpoint: MobileEndpoint; device: MobileDevice }
export interface StreamEvent { connectionId: string; profileId: string; status?: 'connected' | 'disconnected' | 'revoked'; data?: string }
interface NativeGateway {
  pair(input: { enrollment: MobileEnrollment; endpointIndex: number; deviceName: string; destinationConfirmed: boolean; mobileHostId: string }): Promise<{ profile: GatewayProfile }>
  listProfiles(): Promise<{ profiles: GatewayProfile[] }>
  deleteProfile(input: { profileId: string }): Promise<void>
  request(input: { profileId: string; path: string; method: 'GET' | 'POST'; body?: unknown; readId?: string }): Promise<{ data: unknown }>
  cancelRead(input: { profileId: string; readId: string }): Promise<void>
  openStream(input: { profileId: string; hostId: string; sessionId: string; from: number; connectionId: string; mode?: 'terminal' | 'chat' }): Promise<void>
  send(input: { connectionId: string; type: 'input' | 'resize'; data?: string; cols?: number; rows?: number }): Promise<void>
  closeStream(input: { connectionId: string }): Promise<void>
  addListener(name: 'stream', callback: (event: StreamEvent) => void): Promise<PluginListenerHandle>
}
export const Gateway = registerPlugin<NativeGateway>('CrowGateway')
export async function api<T>(profileId: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  if (method !== 'GET') return (await Gateway.request({ profileId, path, method, body })).data as T
  const readId = crypto.randomUUID()
  const response = await boundedRead(() => Gateway.request({ profileId, path, method, readId }), () => Gateway.cancelRead({ profileId, readId }), signal) as { data: unknown }
  return response.data as T
}
