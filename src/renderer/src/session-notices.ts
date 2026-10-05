import type { Notice, Project, SessionInfo, WorkspaceTab } from '../../shared/types'

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

export function shouldNotifyNotice(notices: Notice[], incoming: Notice): boolean {
  const previous = notices.find((notice) => notice.hostId === incoming.hostId && notice.id === incoming.id)
  return !!incoming.requiresAttention && !incoming.read && !previous?.read && !previous?.requiresAttention
}

export function unreadSessionCountForProject(notices: Notice[], hostId: string, sessions: SessionInfo[]): number {
  const unreadSessionIds = new Set(notices.filter((notice) => !notice.read && notice.requiresAttention && notice.hostId === hostId).map((notice) => notice.sessionId))
  return sessions.filter((session) => unreadSessionIds.has(session.id)).length
}
