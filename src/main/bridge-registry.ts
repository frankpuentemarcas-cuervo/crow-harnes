import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { id, sessionId } from './bridge-policy.ts'

const binding = z.object({
  id, hostId: id, hostRevision: z.string().regex(/^[0-9a-f]{64}$/), projectId: id, sessionId, root: z.string().startsWith('/'), registeredAt: z.string().datetime()
}).strict()
export const remoteTaskSchema = z.object({
  id: sessionId, sessionId, root: z.string().startsWith('/'),
  state: z.enum(['dispatching', 'pending', 'completed', 'uncertain', 'interrupted']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  result: z.literal('Hola').optional(),
  issue: z.enum(['runtime-restarted', 'dispatch-outcome-unknown', 'terminal-ownership-changed']).optional()
}).strict().refine((task) => (task.state === 'completed') === (task.result === 'Hola'), 'Invalid greeting result')
const request = z.object({
  requestId: id, clientId: z.string(), orchestratorId: id,
  taskId: sessionId, hostId: id, hostRevision: z.string().regex(/^[0-9a-f]{64}$/), projectId: id, sessionId,
  root: z.string().startsWith('/'), state: z.enum(['prepared', 'uncertain', 'dispatching', 'pending', 'completed', 'interrupted']),
  createdAt: z.string().datetime(), observedAt: z.string().datetime().optional(),
  remoteUpdatedAt: z.string().datetime().optional(), result: z.literal('Hola').optional()
}).strict().refine((item) => (item.state === 'completed') === (item.result === 'Hola'), 'Invalid stored result')
const registry = z.object({
  version: z.literal(1), instanceId: id, orchestrators: z.array(binding).max(100), requests: z.array(request).max(1000)
}).strict().superRefine((value, ctx) => {
  const bindings = new Set(value.orchestrators.map((item) => item.id))
  if (bindings.size !== value.orchestrators.length || new Set(value.orchestrators.map((item) => item.hostId)).size !== value.orchestrators.length ||
      new Set(value.requests.map((item) => JSON.stringify([item.clientId, item.requestId]))).size !== value.requests.length || new Set(value.requests.map((item) => item.taskId)).size !== value.requests.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate bridge identity' })
  }
  for (const item of value.requests) {
    const owner = value.orchestrators.find((binding) => binding.id === item.orchestratorId)
    if (!owner || owner.hostId !== item.hostId || owner.hostRevision !== item.hostRevision || owner.projectId !== item.projectId || owner.sessionId !== item.sessionId || owner.root !== item.root) {
      ctx.addIssue({ code: 'custom', message: 'Invalid task relationship' })
    }
  }
})
export type Orchestrator = z.infer<typeof binding>
export type BridgeRequest = z.infer<typeof request>

export class BridgeRegistry {
  private readonly path: string
  private state: z.infer<typeof registry>

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.path = join(directory, 'bridge.json')
    this.state = existsSync(this.path)
      ? registry.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { version: 1, instanceId: randomUUID(), orchestrators: [], requests: [] }
    // Fail closed on corrupt storage: resetting would lose deduplication.
    if (!existsSync(this.path)) this.write(this.state)
  }

  snapshot(): z.infer<typeof registry> { return structuredClone(this.state) }

  register(input: Omit<Orchestrator, 'id' | 'registeredAt'>): Orchestrator {
    const old = this.state.orchestrators.find((item) => item.hostId === input.hostId)
    if (old) {
      if (old.hostRevision !== input.hostRevision || old.projectId !== input.projectId || old.sessionId !== input.sessionId || old.root !== input.root) throw new Error('El host ya tiene otro orquestador; requiere cambio del propietario.')
      return structuredClone(old)
    }
    const value = binding.parse({ ...input, id: randomUUID(), registeredAt: new Date().toISOString() })
    this.write({ ...this.state, orchestrators: [...this.state.orchestrators, value] })
    return structuredClone(value)
  }

  prepare(value: BridgeRequest): void {
    this.write({ ...this.state, requests: [...this.state.requests, request.parse(value)] })
  }

  update(value: BridgeRequest): void {
    const old = this.state.requests.find((item) => item.requestId === value.requestId && item.clientId === value.clientId)
    if (!old) throw new Error('Solicitud desconocida.')
    // Concurrent polls cannot roll back a durable final result or a newer snapshot.
    if (old.state === 'completed' || old.state === 'interrupted' || (old.remoteUpdatedAt && value.remoteUpdatedAt && old.remoteUpdatedAt > value.remoteUpdatedAt)) return
    this.write({ ...this.state, requests: this.state.requests.map((item) => item === old ? request.parse(value) : item) })
  }

  private write(next: z.infer<typeof registry>): void {
    registry.parse(next)
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
    this.state = next
  }
}
