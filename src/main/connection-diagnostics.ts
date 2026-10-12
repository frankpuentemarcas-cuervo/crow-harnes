import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type ConnectionTransport = 'openssh' | 'ssh2'
export type ConnectionDiagnosticEvent =
  | 'connect-start' | 'connect-success' | 'connect-failed' | 'transport-lost'
  | 'tunnel-exit' | 'tunnel-error' | 'api-unauthorized' | 'health-check-failed'
  | 'request-transport-error' | 'reconnect-scheduled' | 'status-change'
export type ConnectionFailureReason =
  | 'network-reset' | 'network-timeout' | 'network-unreachable' | 'dns-failure'
  | 'authentication-failed' | 'host-key-rejected' | 'forwarding-failed'
  | 'service-unavailable' | 'connection-closed' | 'ssh-error' | 'unknown'

export interface ConnectionDiagnostic {
  at: string
  hostId: string
  transport: ConnectionTransport
  event: ConnectionDiagnosticEvent
  reason?: ConnectionFailureReason
  code?: string
  status?: number
  exitCode?: number | null
  retryMs?: number
  state?: string
}

const MAX_FILE_BYTES = 1024 * 1024
const SAFE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_SOCKET_CLOSED',
  'ERR_SSH_CONNECTION', 'ERR_SSH_HANDSHAKE', 'ERR_SSH_PROTOCOL', 'ERR_SSH_KEY_PARSE'
])

export function safeFailureReason(value: unknown): ConnectionFailureReason {
  const error = value as { code?: unknown; message?: unknown } | undefined
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  if (code === 'ECONNRESET' || /econnreset|connection reset|reset by peer/.test(message)) return 'network-reset'
  if (code === 'ETIMEDOUT' || /etimedout|timed out|timeout/.test(message)) return 'network-timeout'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || /ehostunreach|enetunreach|network is unreachable|no route to host/.test(message)) return 'network-unreachable'
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND' || /eai_again|enotfound|could not resolve|name or service not known|temporary failure in name resolution/.test(message)) return 'dns-failure'
  if (/permission denied|authentication failed|auth fail|too many authentication failures/.test(message)) return 'authentication-failed'
  if (/host key verification failed|host key.*(mismatch|unknown)|not in known_hosts/.test(message)) return 'host-key-rejected'
  if (/forwarding.*(failed|denied)|remote port forwarding failed/.test(message)) return 'forwarding-failed'
  if (/service unavailable|connection refused/.test(message) || code === 'ECONNREFUSED') return 'service-unavailable'
  if (/connection (closed|lost)|socket hang up|broken pipe/.test(message) || code === 'EPIPE') return 'connection-closed'
  if (SAFE_CODES.has(code) || /ssh|handshake|protocol/.test(message)) return 'ssh-error'
  return 'unknown'
}

function safeCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && SAFE_CODES.has(code) ? code : undefined
}

/** Local-only, bounded JSONL diagnostics. Never persists raw SSH output or error messages. */
export class ConnectionDiagnosticsStore {
  private readonly file: string
  private readonly backup: string

  constructor(userDataPath: string) {
    this.file = join(userDataPath, 'connection-diagnostics.jsonl')
    this.backup = `${this.file}.1`
  }

  record(input: Omit<ConnectionDiagnostic, 'at'> & { at?: string }): void {
    try {
      const record: ConnectionDiagnostic = {
        at: input.at || new Date().toISOString(), hostId: input.hostId,
        transport: input.transport, event: input.event,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.code && SAFE_CODES.has(input.code) ? { code: input.code } : {}),
        ...(Number.isInteger(input.status) && input.status! >= 100 && input.status! <= 599 ? { status: input.status } : {}),
        ...(input.exitCode === null || Number.isInteger(input.exitCode) ? { exitCode: input.exitCode } : {}),
        ...(Number.isInteger(input.retryMs) && input.retryMs! >= 0 ? { retryMs: input.retryMs } : {}),
        ...(input.state && /^[a-z-]{1,32}$/.test(input.state) ? { state: input.state } : {})
      }
      const line = `${JSON.stringify(record)}\n`
      if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
        try { renameSync(this.file, this.backup) } catch { writeFileSync(this.file, '', { mode: 0o600 }) }
      }
      appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 })
    } catch { /* Diagnostics must never break the connection path. */ }
  }

  exportJSON(hostId: string): string {
    const records: ConnectionDiagnostic[] = []
    for (const path of [this.backup, this.file]) {
      try {
        for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
          if (!line) continue
          try {
            const row = JSON.parse(line) as ConnectionDiagnostic
            if (row.hostId === hostId) records.push(row)
          } catch { /* Ignore a partial/corrupt trailing record. */ }
        }
      } catch { /* File does not exist yet. */ }
    }
    return JSON.stringify({ format: 'crow-connection-diagnostics-v1', records }, null, 2)
  }
}

export function safeConnectionCode(value: unknown): string | undefined { return safeCode(value) }
