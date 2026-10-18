import { readFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const id = z.string().uuid()
export const sessionId = z.string().regex(/^[0-9a-f]{32}$/)
// Chat request ids are also the remote structured-chat ledger key, whose regex
// requires a lowercase UUID v4. Enforcing it here rejects at the MCP boundary
// instead of after a network round trip the remote would refuse anyway.
export const chatRequestId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const grant = z.object({
  hostId: id, projectId: id, sessionId,
  operations: z.array(z.enum(['discover', 'register', 'hello', 'result', 'rename', 'chat'])).min(1).max(6),
  priority: z.number().int().min(0).max(100).default(50)
}).strict()
// Deprecated compatibility field. Creation no longer needs a per-project
// authorization: any bearer-authenticated client configured by the owner may
// create in any project already present in Crow's catalog. `projectGrants` is
// still parsed so older owner policy files keep loading, but it is IGNORED for
// creation and must never be required; the grants above stay independent and
// only govern discover/register/hello/result on existing terminals.
const projectGrant = z.object({
  hostId: id, projectId: id,
  operations: z.array(z.literal('createTerminal')).length(1),
  priority: z.number().int().min(0).max(100).default(50)
}).strict()
export const policySchema = z.object({
  version: z.literal(1), port: z.number().int().min(1024).max(65535),
  clients: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
    grants: z.array(grant).max(100).default([]),
    projectGrants: z.array(projectGrant).max(100).default([]),
    // Owner-controlled opt-in for creating bypass-permission terminals. Default
    // false: existing clients keep normal-only creation and every bypass call
    // still requires an explicit per-call confirmation.
    allowBypass: z.boolean().default(false),
    preferences: z.object({ replyLanguage: z.enum(['es', 'en']).default('es'), pollingSeconds: z.number().int().min(5).max(60).default(10) }).strict().default({})
  }).strict()).min(1).max(20)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.clients.map((item) => item.id)).size !== value.clients.length ||
      new Set(value.clients.map((item) => item.tokenSha256)).size !== value.clients.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate bridge identity' })
  }
  if (value.clients.some((client) => client.grants.some((grant) => grant.operations.includes('hello') && !grant.operations.includes('result')))) {
    ctx.addIssue({ code: 'custom', message: 'Hello requires result access' })
  }
})
export type BridgePolicy = z.infer<typeof policySchema>
export type BridgeClient = BridgePolicy['clients'][number]
export type BridgeOperation = BridgeClient['grants'][number]['operations'][number]

// The owner edits an out-of-repository file. The bridge never issues tokens to
// models, infers permissions from tool text, or includes SSH configuration.
export function readBridgePolicy(path: string): BridgePolicy {
  if (!isAbsolute(path)) throw new Error('MCP requiere una ruta absoluta de configuración del propietario.')
  try { return policySchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  catch { throw new Error('Configuración MCP inválida; revisala fuera del chat.') }
}

export function authenticate(policy: BridgePolicy, authorization?: string): BridgeClient | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization || '')
  if (!match) return
  const hash = createHash('sha256').update(match[1]).digest()
  return policy.clients.find((client) => timingSafeEqual(hash, Buffer.from(client.tokenSha256, 'hex')))
}
