export function sessionNameKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`
}

export function hasWorkingAgent(sessions: Array<{ state: string; agentState?: string }>): boolean {
  return sessions.some((session) => session.state === 'running' && session.agentState === 'working')
}

export function sortSessionsByStart<T extends { id: string; startedAt: string }>(sessions: T[]): T[] {
  return [...sessions].sort((left, right) => {
    const leftTime = Date.parse(left.startedAt)
    const rightTime = Date.parse(right.startedAt)
    const timeOrder = (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0)
    return timeOrder || left.id.localeCompare(right.id)
  })
}
