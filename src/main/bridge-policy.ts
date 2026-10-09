import { readFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const id = z.string().uuid()
export const sessionId = z.string().regex(/^[0-9a-f]{32}$/)
const grant = z.object({
  hostId: id, projectId: id, sessionId,
  operations: z.array(z.enum(['discover', 'register', 'hello', 'result'])).min(1).max(4),
  priority: z.number().int().min(0).max(100).default(50)
}).strict()
export const policySchema = z.object({
  version: z.literal(1), port: z.number().int().min(1024).max(65535),
  clients: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
    grants: z.array(grant).min(1).max(100),
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
