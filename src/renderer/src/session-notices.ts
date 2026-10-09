import type { Notice, Project, SessionInfo, WorkspaceTab } from '../../shared/types'
import { isFreshNotice } from './completion-sound.ts'

// UI snapshots can contain an AI result before its IPC event arrives. They are
// not proof that audio played: dedupe live deliveries separately from badges.
export class NoticeSoundTracker {
  private deliveries = new Map<string, { handled: boolean; pendingAt?: number }>()

  restore(notices: Notice[]): void {
    for (const notice of notices) {
      const key = JSON.stringify([notice.hostId, notice.id])
      if (!this.deliveries.has(key)) this.remember(key, { handled: true })
    }
  }

  accept(history: Notice[], incoming: Notice, now = Date.now()): boolean {
    const key = JSON.stringify([incoming.hostId, incoming.id])
    let delivery = this.deliveries.get(key)
    if (!delivery) {
      delivery = { handled: false }
      if (incoming.classification?.source === 'pending' && isFreshNotice(incoming.at, now)) delivery.pendingAt = now
      this.remember(key, delivery)
    }
    const reviewed = incoming.read || history.some(notice => notice.hostId === incoming.hostId && notice.id === incoming.id && notice.read)
    if (reviewed) delivery.handled = true
    if (delivery.handled || !incoming.requiresAttention) return false
    delivery.handled = true
    // A fresh live pending event must not lose its sound just because inference
    // crosses the remote timestamp cutoff. Never rejuvenate reconnect history.
    const pendingAge = delivery.pendingAt === undefined ? Infinity : now - delivery.pendingAt
    return isFreshNotice(incoming.at, now) || (pendingAge >= 0 && pendingAge <= 120_000)
  }

  private remember(key: string, delivery: { handled: boolean; pendingAt?: number }): void {
    this.deliveries.set(key, delivery)
    if (this.deliveries.size > 256) this.deliveries.delete(this.deliveries.keys().next().value!)
  }
}

export function unreadNoticesForSession(notices: Notice[], hostId: string, sessionId: string): Notice[] {
  return notices.filter((notice) => !notice.read && notice.requiresAttention && notice.hostId === hostId && notice.sessionId === sessionId)
}

export function unreadNoticesForTab(notices: Notice[], projects: Project[], tab: WorkspaceTab): Notice[] {
  if (tab.kind !== 'terminal' || !tab.sessionId) return []
  const project = projects.find((item) => item.id === tab.projectId)
  return project ? notices.filter((notice) => !notice.read && notice.hostId === project.hostId && notice.sessionId === tab.sessionId && (notice.requiresAttention || notice.classification?.source === 'pending')) : []
}

export function mergeNotice(notices: Notice[], incoming: Notice): Notice[] {
  const previous = notices.find((notice) => notice.hostId === incoming.hostId && notice.id === incoming.id)
  return [{ ...incoming, read: incoming.read || !!previous?.read }, ...notices.filter((notice) => !(notice.hostId === incoming.hostId && notice.id === incoming.id))].slice(0, 100)
}

export function unreadSessionCountForProject(notices: Notice[], hostId: string, sessions: SessionInfo[]): number {
  const unreadSessionIds = new Set(notices.filter((notice) => !notice.read && notice.requiresAttention && notice.hostId === hostId).map((notice) => notice.sessionId))
  return sessions.filter((session) => unreadSessionIds.has(session.id)).length
}
