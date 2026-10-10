import type { SavedState } from './types'

/** Persisted metadata is not proof of permission; use current server-scoped IDs. */
export function projectVisibleSessions(value: SavedState, visible: ReadonlySet<string>): SavedState {
  const tabs = value.tabs.filter(tab => tab.kind !== 'terminal' || visible.has(`${value.projects.find(project => project.id === tab.projectId)?.hostId}:${tab.sessionId}`))
  return { ...value, notices: value.notices.filter(notice => visible.has(`${notice.hostId}:${notice.sessionId}`)), sessionNames: Object.fromEntries(Object.entries(value.sessionNames).filter(([key]) => visible.has(key))), tabs, activeTabs: Object.fromEntries(Object.entries(value.activeTabs).filter(([, id]) => tabs.some(tab => tab.id === id))) }
}

export function withoutHostWorkspace(value: SavedState, hostId: string): SavedState {
  const projects = new Set(value.projects.filter(project => project.hostId === hostId).map(project => project.id))
  return { ...value, tabs: value.tabs.filter(tab => !projects.has(tab.projectId)), activeTabs: Object.fromEntries(Object.entries(value.activeTabs).filter(([id]) => !projects.has(id))), notices: value.notices.filter(notice => notice.hostId !== hostId), sessionNames: Object.fromEntries(Object.entries(value.sessionNames).filter(([id]) => !id.startsWith(hostId + ':'))) }
}
