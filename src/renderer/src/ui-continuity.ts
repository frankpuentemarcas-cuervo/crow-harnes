export function canFocusTerminal(document: Pick<Document, 'activeElement' | 'body' | 'querySelector'>, surface: Pick<HTMLElement, 'contains'>): boolean {
  if (document.querySelector('dialog[open], [aria-modal="true"]')) return false
  return !document.activeElement || document.activeElement === document.body || surface.contains(document.activeElement)
}

// Request order, rather than arrival order, decides which snapshot may update the UI.
export class RequestVersions {
  private versions = new Map<string, number>()
  begin(key: string): number {
    const next = (this.versions.get(key) || 0) + 1
    this.versions.set(key, next)
    return next
  }
  current(key: string, version: number): boolean { return this.versions.get(key) === version }
}

export function sidebarWidth(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 280 ? Math.min(560, Math.round(parsed)) : 280
}

export function visibleSidebarWidth(preferred: number, viewport: number): number {
  return Math.min(sidebarWidth(preferred), Math.max(280, viewport - 650))
}

export function withoutSessionTabs<T extends { projectId: string; sessionId?: string }>(tabs: T[], projects: Set<string>, sessionId: string): T[] {
  return tabs.filter(tab => !(projects.has(tab.projectId) && tab.sessionId === sessionId))
}
