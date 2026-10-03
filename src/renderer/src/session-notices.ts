import type { Notice, SessionInfo } from '../../shared/types'

export function unreadNoticesForSession(notices: Notice[], hostId: string, sessionId: string): Notice[] {
  return notices.filter((notice) => !notice.read && notice.hostId === hostId && notice.sessionId === sessionId)
}

export function unreadSessionCountForProject(notices: Notice[], hostId: string, sessions: SessionInfo[]): number {
  const unreadSessionIds = new Set(notices.filter((notice) => !notice.read && notice.hostId === hostId).map((notice) => notice.sessionId))
  return sessions.filter((session) => unreadSessionIds.has(session.id)).length
}
