import type { Notice, Project, SessionInfo, WorkspaceTab } from '../../shared/types'

export function unreadNoticesForSession(notices: Notice[], hostId: string, sessionId: string): Notice[] {
  return notices.filter((notice) => !notice.read && notice.hostId === hostId && notice.sessionId === sessionId)
}

export function unreadNoticesForTab(notices: Notice[], projects: Project[], tab: WorkspaceTab): Notice[] {
  if (tab.kind !== 'terminal' || !tab.sessionId) return []
  const project = projects.find((item) => item.id === tab.projectId)
  return project ? unreadNoticesForSession(notices, project.hostId, tab.sessionId) : []
}

export function unreadSessionCountForProject(notices: Notice[], hostId: string, sessions: SessionInfo[]): number {
  const unreadSessionIds = new Set(notices.filter((notice) => !notice.read && notice.hostId === hostId).map((notice) => notice.sessionId))
  return sessions.filter((session) => unreadSessionIds.has(session.id)).length
}
