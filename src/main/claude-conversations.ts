import { posix } from 'node:path'
import { normalizeSessionName } from '../shared/session-list.ts'
import type { ClaudeConversation, ClaudeConversationResume, Project, SessionInfo } from '../shared/types'

interface Remote {
  status(): string
  api<T>(method: string, path: string, body?: unknown): Promise<T>
}
interface Context {
  project(id: string): Project | undefined
  connection(hostId: string): Remote
  generation(): string | number
  authorize(projectId: string, hostId: string): Promise<{ actorId: string; root: string }>
  name(hostId: string, sessionId: string): string | undefined
  rename(hostId: string, sessionId: string, name: string): unknown
}
const recordID = /^[0-9a-f]{32}$/
const requestID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const unavailable = (): Error => new Error('Conversación no disponible para este proyecto o identidad. No se abrió un chat nuevo.')

/** The renderer never supplies a native Claude UUID, transcript path or launch root. */
export class ClaudeConversationService {
  private context: Context
  private resuming = new Map<string, Promise<ClaudeConversationResume>>()
  constructor(context: Context) { this.context = context }

  private async scope(hostId: string, projectId: string) {
    const context = this.context, generation = context.generation(), project = context.project(projectId)
    if (!project || project.hostId !== hostId || !project.root.startsWith('/') || posix.normalize(project.root) !== project.root) throw unavailable()
    const root = project.root, remote = context.connection(hostId)
    if (remote.status() !== 'connected') throw new Error('Conectá el host para reanudar conversaciones.')
    const actor = await context.authorize(projectId, hostId)
    const check = async (): Promise<void> => {
      const latest = context.project(projectId)
      if (remote.status() !== 'connected' || context.connection(hostId) !== remote || generation !== context.generation() || latest?.hostId !== hostId || latest?.root !== root) throw unavailable()
      const current = await context.authorize(projectId, hostId)
      if (current.actorId !== actor.actorId || current.root !== root || generation !== context.generation() || remote.status() !== 'connected') throw unavailable()
    }
    if (!actor.actorId || actor.actorId.startsWith('legacy:') || actor.root !== root) throw unavailable()
    await check()
    return { remote, root, actorId: actor.actorId, check }
  }

  private async api<T>(remote: Remote, method: string, path: string, body?: unknown): Promise<T> {
    try { return await remote.api<T>(method, path, body) }
    catch (error) {
      if ((error as { status?: number })?.status === 404 && (String((error as Error)?.message).includes('404 page not found') || path === '/api/claude-conversations')) throw new Error('Actualizá crowd para reanudar conversaciones.')
      throw error
    }
  }

  private row(value: ClaudeConversation, root: string): ClaudeConversation {
    if (!value || !recordID.test(value.id) || value.root !== root || !['normal', 'bypass'].includes(value.mode) || !['active', 'available', 'pending', 'unavailable'].includes(value.status) || typeof value.name !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || (value.sessionId !== undefined && !recordID.test(value.sessionId))) throw unavailable()
    return { id: value.id, root, name: normalizeSessionName(value.name), mode: value.mode, createdAt: value.createdAt, updatedAt: value.updatedAt, status: value.status, ...(value.sessionId ? { sessionId: value.sessionId } : {}), ...(value.reason ? { reason: String(value.reason).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) } : {}) }
  }

  private terminal(session: SessionInfo, row: ClaudeConversation, actorId: string): void {
    if (!session || !recordID.test(session.id) || session.id !== row.sessionId || session.root !== row.root || session.ownerId !== actorId || session.agent !== 'claude' || session.mode !== row.mode || session.claudeConversationId !== row.id || session.readOnly || !['running', 'sleeping'].includes(session.state)) throw unavailable()
  }

  async list(hostId: string, projectId: string): Promise<ClaudeConversation[]> {
    const scope = await this.scope(hostId, projectId)
    const values = await this.api<ClaudeConversation[]>(scope.remote, 'GET', '/api/claude-conversations')
    if (!Array.isArray(values)) throw unavailable()
    const rows = values.filter(value => value?.root === scope.root).map(value => this.row(value, scope.root))
    const sessions = await scope.remote.api<SessionInfo[]>('GET', '/api/sessions')
    await scope.check()
    for (const row of rows) {
      const session = sessions.find(session => session.id === row.sessionId)
      if (!session) continue
      try { this.terminal(session, row, scope.actorId) } catch { continue }
      const localName = this.context.name(hostId, session.id)
      if (!row.name && localName) {
        // Migrate only a live, exact owner+logical-record mapping, never root guesses.
        await scope.check()
        const named = this.row(await this.api<ClaudeConversation>(scope.remote, 'POST', `/api/claude-conversations/${row.id}/name`, { name: normalizeSessionName(localName) }), scope.root)
        if (named.id !== row.id) throw unavailable()
        await scope.check(); row.name = named.name
      }
      // A read started before an explicit rename must not restore an older alias.
      if (!this.context.name(hostId, session.id)) this.context.rename(hostId, session.id, row.name)
    }
    return rows
  }

  async resume(hostId: string, projectId: string, id: string, requestId: string): Promise<ClaudeConversationResume> {
    if (!recordID.test(id) || !requestID.test(requestId)) throw unavailable()
    const scope = await this.scope(hostId, projectId)
    const key = JSON.stringify([hostId, projectId, scope.actorId, scope.root, this.context.generation(), id])
    const existing = this.resuming.get(key)
    if (existing) return existing
    const operation = this.doResume(hostId, projectId, id, requestId, scope)
    this.resuming.set(key, operation)
    try { return await operation } finally { if (this.resuming.get(key) === operation) this.resuming.delete(key) }
  }

  private async doResume(hostId: string, projectId: string, id: string, requestId: string, scope: Awaited<ReturnType<ClaudeConversationService['scope']>>): Promise<ClaudeConversationResume> {
    const rows = await this.list(hostId, projectId), row = rows.find(row => row.id === id)
    if (!row || row.status === 'unavailable') throw unavailable()
    await scope.check()
    let result: ClaudeConversationResume
    if (row.status === 'active' && row.sessionId) {
      const sessions = await scope.remote.api<SessionInfo[]>('GET', '/api/sessions')
      const session = sessions.find(session => session.id === row.sessionId)
      if (!session) throw unavailable()
      this.terminal(session, row, scope.actorId)
      await scope.check()
      result = { conversation: row, session: session.state === 'sleeping' ? await scope.remote.api<SessionInfo>('POST', `/api/sessions/${session.id}/wake`) : session, state: 'existing' }
    } else {
      result = await this.api<ClaudeConversationResume>(scope.remote, 'POST', `/api/claude-conversations/${id}/resume`, { requestId })
    }
    await scope.check()
    const conversation = this.row(result?.conversation, scope.root)
    if (conversation.id !== id || !['existing', 'pending', 'ready'].includes(result.state) || (result.state === 'ready' && conversation.status !== 'active') || (result.state === 'pending' && conversation.status !== 'pending')) throw unavailable()
    if (result.session) {
      this.terminal(result.session, conversation, scope.actorId)
      this.context.rename(hostId, result.session.id, conversation.name)
    } else if (result.state !== 'pending') throw unavailable()
    return { conversation, ...(result.session ? { session: result.session } : {}), state: result.state }
  }

  async rename(hostId: string, projectId: string, id: string, name: string): Promise<ClaudeConversation> {
    if (!recordID.test(id)) throw unavailable()
    const scope = await this.scope(hostId, projectId)
    const values = await this.api<ClaudeConversation[]>(scope.remote, 'GET', '/api/claude-conversations')
    if (!Array.isArray(values)) throw unavailable()
    const row = values.find(row => row.id === id && row.root === scope.root)
    if (!row) throw unavailable()
    this.row(row, scope.root)
    await scope.check()
    const named = this.row(await this.api<ClaudeConversation>(scope.remote, 'POST', `/api/claude-conversations/${id}/name`, { name: normalizeSessionName(name) }), scope.root)
    await scope.check()
    if (named.id !== id) throw unavailable()
    return named
  }

  async preserveTerminalName(hostId: string, projectId: string, session: SessionInfo, name = this.context.name(hostId, session.id)): Promise<void> {
    if (!session.claudeConversationId) return // Legacy terminals cannot be guessed by project.
    const scope = await this.scope(hostId, projectId)
    if (!recordID.test(session.claudeConversationId) || session.root !== scope.root || session.ownerId !== scope.actorId || session.agent !== 'claude' || session.readOnly) throw unavailable()
    const values = await this.api<ClaudeConversation[]>(scope.remote, 'GET', '/api/claude-conversations')
    if (!Array.isArray(values)) throw unavailable()
    const value = values.find(row => row.id === session.claudeConversationId && row.root === scope.root)
    // Explicitly forgotten metadata must not prevent removing its old PTY entry.
    if (!value) { await scope.check(); return }
    const row = this.row(value, scope.root)
    // Closed sessions may be retained until the user removes their terminal entry.
    if (session.mode !== row.mode) throw unavailable()
    await scope.check()
    // Resume may already have replaced this old Crow terminal. Its obsolete alias
    // must not overwrite the new terminal's conversation name or block deletion.
    if (session.id !== row.sessionId) return
    if (name !== undefined && normalizeSessionName(name) !== row.name) {
      const named = await this.rename(hostId, projectId, row.id, name)
      await scope.check()
      this.context.rename(hostId, session.id, named.name)
    }
  }

  async forget(hostId: string, projectId: string, id: string): Promise<void> {
    if (!recordID.test(id)) throw unavailable()
    const scope = await this.scope(hostId, projectId), row = (await this.list(hostId, projectId)).find(row => row.id === id)
    if (!row || ['active', 'pending'].includes(row.status)) throw unavailable()
    await scope.check()
    await this.api(scope.remote, 'DELETE', `/api/claude-conversations/${id}`)
    await scope.check()
  }
}
