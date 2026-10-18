import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { chatRequestId, id, sessionId } from './bridge-policy.ts'

const binding = z.object({
  id, hostId: id, hostRevision: z.string().regex(/^[0-9a-f]{64}$/), projectId: id, sessionId, root: z.string().startsWith('/'), actorId: z.string().max(200).optional(), registeredAt: z.string().datetime()
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
  root: z.string().startsWith('/'), actorId: z.string().max(200).optional(), state: z.enum(['prepared', 'uncertain', 'dispatching', 'pending', 'completed', 'interrupted']),
  createdAt: z.string().datetime(), observedAt: z.string().datetime().optional(),
  remoteUpdatedAt: z.string().datetime().optional(), result: z.literal('Hola').optional()
}).strict().refine((item) => (item.state === 'completed') === (item.result === 'Hola'), 'Invalid stored result')
// Durable idempotency record for created terminals. `serverKey` is the stable
// key sent to crowd so a retry after a lost response returns the same session.
// `mode` is part of the fingerprint: replaying the same requestKey with another
// permission mode must conflict instead of silently reusing a terminal.
const creation = z.object({
  requestKey: id, clientId: z.string(), serverKey: sessionId,
  hostId: id, hostRevision: z.string().regex(/^[0-9a-f]{64}$/), projectId: id,
  root: z.string().startsWith('/'), agent: z.enum(['claude', 'codex']),
  mode: z.enum(['normal', 'bypass']).default('normal'),
  actorId: z.string().max(200).optional(), sessionId: sessionId.optional(),
  state: z.enum(['prepared', 'created']), createdAt: z.string().datetime(),
  observedAt: z.string().datetime().optional()
}).strict().refine((item) => (item.state === 'created') === (item.sessionId !== undefined), 'Invalid creation state')
// Durable record of an alias rename applied through MCP. The intent is persisted
// as `prepared` BEFORE Crow's alias is written, then marked `applied`, so a crash
// between the two resumes the same prepared work instead of losing the request.
// The ledger pins the request id to its exact target and name so a retry with the
// same id and a changed payload is rejected before any write. Rows written by the
// previous format (only `applied`, with `appliedAt`) stay readable.
const rename = z.object({
  requestId: id, clientId: z.string(), hostId: id, hostRevision: z.string().regex(/^[0-9a-f]{64}$/), projectId: id,
  sessionId, root: z.string().startsWith('/'), name: z.string().min(1).max(200), via: z.enum(['created', 'grant']),
  actorId: z.string().max(200).optional(), state: z.enum(['prepared', 'applied']),
  createdAt: z.string().datetime(), appliedAt: z.string().datetime().optional()
}).strict().refine((item) => (item.state === 'applied') === (item.appliedAt !== undefined), 'Invalid rename state')
// Durable record of a structured chat submission. The prompt text is never
// persisted: `textHash` binds the request id to the exact payload so a changed
// text/ target rejects before sending, and the same hash correlates the assistant
// reply in the remote chat history without storing prompt content.
const message = z.object({
  requestId: chatRequestId, clientId: z.string(), hostId: id, hostRevision: z.string().regex(/^[0-9a-f]{64}$/), projectId: id,
  sessionId, root: z.string().startsWith('/'), textHash: z.string().regex(/^[0-9a-f]{64}$/), textLength: z.number().int().min(1).max(4096),
  baselineSeq: z.number().int().min(0), via: z.enum(['created', 'grant']), actorId: z.string().max(200).optional(),
  delivery: z.enum(['pending', 'written', 'accepted', 'uncertain', 'rejected']),
  state: z.enum(['pending', 'completed', 'rejected', 'uncertain', 'interrupted']),
  correlation: z.enum(['assistant-after-user-sequence', 'assistant-after-baseline', 'unavailable']).default('unavailable'),
  response: z.string().max(8000).optional(), responseSeq: z.number().int().min(1).optional(),
  createdAt: z.string().datetime(), observedAt: z.string().datetime().optional(), remoteUpdatedAt: z.string().datetime().optional()
}).strict().refine((item) => (item.state === 'completed') === (item.response !== undefined && item.responseSeq !== undefined), 'Invalid message result')
const registry = z.object({
  version: z.literal(1), instanceId: id, orchestrators: z.array(binding).max(100), requests: z.array(request).max(1000),
  creations: z.array(creation).max(500).default([]), renames: z.array(rename).max(500).default([]), messages: z.array(message).max(1000).default([])
}).strict().superRefine((value, ctx) => {
  const bindings = new Set(value.orchestrators.map((item) => item.id))
  if (bindings.size !== value.orchestrators.length || new Set(value.orchestrators.map((item) => item.hostId)).size !== value.orchestrators.length ||
      new Set(value.requests.map((item) => JSON.stringify([item.clientId, item.requestId]))).size !== value.requests.length || new Set(value.requests.map((item) => item.taskId)).size !== value.requests.length ||
      new Set(value.creations.map((item) => JSON.stringify([item.clientId, item.requestKey]))).size !== value.creations.length || new Set(value.creations.map((item) => item.serverKey)).size !== value.creations.length ||
      new Set(value.renames.map((item) => JSON.stringify([item.clientId, item.requestId]))).size !== value.renames.length ||
      new Set(value.messages.map((item) => JSON.stringify([item.clientId, item.requestId]))).size !== value.messages.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate bridge identity' })
  }
  for (const item of value.requests) {
    const owner = value.orchestrators.find((binding) => binding.id === item.orchestratorId)
    if (!owner || owner.actorId !== item.actorId || owner.hostId !== item.hostId || owner.hostRevision !== item.hostRevision || owner.projectId !== item.projectId || owner.sessionId !== item.sessionId || owner.root !== item.root) {
      ctx.addIssue({ code: 'custom', message: 'Invalid task relationship' })
    }
  }
})
export type Orchestrator = z.infer<typeof binding>
export type BridgeRequest = z.infer<typeof request>
export type Creation = z.infer<typeof creation>
export type Rename = z.infer<typeof rename>
export type MessageRecord = z.infer<typeof message>

export class BridgeRegistry {
  private readonly path: string
  private state: z.infer<typeof registry>

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.path = join(directory, 'bridge.json')
    this.state = existsSync(this.path)
      ? registry.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { version: 1, instanceId: randomUUID(), orchestrators: [], requests: [], creations: [], renames: [], messages: [] }
    // Fail closed on corrupt storage: resetting would lose deduplication.
    if (!existsSync(this.path)) this.write(this.state)
  }

  snapshot(): z.infer<typeof registry> { return structuredClone(this.state) }

  register(input: Omit<Orchestrator, 'id' | 'registeredAt'>): Orchestrator {
    const old = this.state.orchestrators.find((item) => item.hostId === input.hostId)
    if (old) {
      if ((old.actorId && old.actorId !== input.actorId) || old.hostRevision !== input.hostRevision || old.projectId !== input.projectId || old.sessionId !== input.sessionId || old.root !== input.root) throw new Error('El host ya tiene otro orquestador; requiere cambio del propietario.')
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

  findCreation(clientId: string, requestKey: string): Creation | undefined {
    const item = this.state.creations.find((item) => item.clientId === clientId && item.requestKey === requestKey)
    return item ? structuredClone(item) : undefined
  }

  prepareCreation(value: Creation): void {
    this.write({ ...this.state, creations: [...this.state.creations, creation.parse(value)] })
  }

  updateCreation(value: Creation): void {
    const old = this.state.creations.find((item) => item.clientId === value.clientId && item.requestKey === value.requestKey)
    if (!old) throw new Error('Creación desconocida.')
    this.write({ ...this.state, creations: this.state.creations.map((item) => item === old ? creation.parse(value) : item) })
  }

  findRename(clientId: string, requestId: string): Rename | undefined {
    const item = this.state.renames.find((item) => item.clientId === clientId && item.requestId === requestId)
    return item ? structuredClone(item) : undefined
  }

  prepareRename(value: Rename): void {
    this.write({ ...this.state, renames: [...this.state.renames, rename.parse(value)] })
  }

  updateRename(value: Rename): void {
    const old = this.state.renames.find((item) => item.clientId === value.clientId && item.requestId === value.requestId)
    if (!old) throw new Error('Renombre desconocido.')
    // An applied rename is never rolled back to prepared by a stale retry.
    if (old.state === 'applied') return
    this.write({ ...this.state, renames: this.state.renames.map((item) => item === old ? rename.parse(value) : item) })
  }

  findMessage(clientId: string, requestId: string): MessageRecord | undefined {
    const item = this.state.messages.find((item) => item.clientId === clientId && item.requestId === requestId)
    return item ? structuredClone(item) : undefined
  }

  prepareMessage(value: MessageRecord): void {
    this.write({ ...this.state, messages: [...this.state.messages, message.parse(value)] })
  }

  updateMessage(value: MessageRecord): void {
    const old = this.state.messages.find((item) => item.clientId === value.clientId && item.requestId === value.requestId)
    if (!old) throw new Error('Solicitud de chat desconocida.')
    // A durable final result is never rolled back by a stale poll.
    if (old.state === 'completed' || old.state === 'rejected' || old.state === 'interrupted') return
    this.write({ ...this.state, messages: this.state.messages.map((item) => item === old ? message.parse(value) : item) })
  }

  private write(next: z.infer<typeof registry>): void {
    registry.parse(next)
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
    this.state = next
  }
}
