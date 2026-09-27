import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Host, Notice, Project, RemoteEvent, SavedState, WorkspaceTab } from '../shared/types'

const initialState = (): SavedState => ({ hosts: [], projects: [], notices: [], eventCursors: {}, tabs: [], activeTabs: {}, selectedProjectId: '' })

export class Store {
  private path = join(app.getPath('userData'), 'state.json')
  private state: SavedState

  constructor() {
    try {
      this.state = existsSync(this.path) ? { ...initialState(), ...JSON.parse(readFileSync(this.path, 'utf8')) } : initialState()
    } catch {
      this.state = initialState()
    }
  }

  snapshot(): SavedState {
    return structuredClone(this.state)
  }

  host(id: string): Host | undefined {
    return this.state.hosts.find((item) => item.id === id)
  }

  project(id: string): Project | undefined {
    return this.state.projects.find((item) => item.id === id)
  }

  saveHost(input: Omit<Host, 'id'> & { id?: string }): SavedState {
    if (!/^[\w@.][\w.@-]*$/.test(input.target) || !input.name.trim() || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !Number.isInteger(input.remotePort) || input.remotePort < 1 || input.remotePort > 65535) {
      throw new Error('Revisá el nombre, destino SSH y puertos del host.')
    }
    const host: Host = { ...input, id: input.id || randomUUID(), name: input.name.trim() }
    const index = this.state.hosts.findIndex((item) => item.id === host.id)
    if (index >= 0) this.state.hosts[index] = host
    else this.state.hosts.push(host)
    this.write()
    return this.snapshot()
  }

  removeHost(id: string): SavedState {
    const removedProjects = new Set(this.state.projects.filter((project) => project.hostId === id).map((project) => project.id))
    this.state.hosts = this.state.hosts.filter((host) => host.id !== id)
    this.state.projects = this.state.projects.filter((project) => project.hostId !== id)
    this.state.tabs = this.state.tabs.filter((tab) => !removedProjects.has(tab.projectId))
    this.state.notices = this.state.notices.filter((notice) => notice.hostId !== id)
    delete this.state.eventCursors[id]
    this.write()
    return this.snapshot()
  }

  saveProject(input: Omit<Project, 'id'> & { id?: string }): SavedState {
    if (!this.host(input.hostId) || !input.name.trim() || !input.root.startsWith('/')) {
      throw new Error('El proyecto necesita un host y una ruta Linux absoluta.')
    }
    const project: Project = { ...input, id: input.id || randomUUID(), name: input.name.trim(), root: input.root.replace(/\/$/, '') || '/' }
    const index = this.state.projects.findIndex((item) => item.id === project.id)
    if (index >= 0) this.state.projects[index] = project
    else this.state.projects.push(project)
    this.write()
    return this.snapshot()
  }

  removeProject(id: string): SavedState {
    this.state.projects = this.state.projects.filter((project) => project.id !== id)
    this.state.tabs = this.state.tabs.filter((tab) => tab.projectId !== id)
    delete this.state.activeTabs[id]
    this.write()
    return this.snapshot()
  }

  saveWorkspace(tabs: WorkspaceTab[], activeTabs: Record<string, string>, selectedProjectId: string): SavedState {
    const projects = new Set(this.state.projects.map((project) => project.id))
    this.state.tabs = tabs.filter((tab) => projects.has(tab.projectId)).slice(0, 150)
    this.state.activeTabs = activeTabs
    this.state.selectedProjectId = projects.has(selectedProjectId) ? selectedProjectId : ''
    this.write()
    return this.snapshot()
  }

  removeSession(hostId: string, sessionId: string): SavedState {
    const projects = new Set(this.state.projects.filter((project) => project.hostId === hostId).map((project) => project.id))
    this.state.tabs = this.state.tabs.filter((tab) => !(projects.has(tab.projectId) && tab.sessionId === sessionId))
    this.state.notices = this.state.notices.filter((notice) => !(notice.hostId === hostId && notice.sessionId === sessionId))
    for (const [projectId, activeId] of Object.entries(this.state.activeTabs)) {
      if (projects.has(projectId) && !this.state.tabs.some((tab) => tab.id === activeId)) {
        this.state.activeTabs[projectId] = this.state.tabs.find((tab) => tab.projectId === projectId)?.id || ''
      }
    }
    this.write()
    return this.snapshot()
  }

  eventCursor(hostId: string): number {
    return this.state.eventCursors[hostId] || 0
  }

  recordEvent(hostId: string, event: RemoteEvent): Notice | undefined {
    if (event.seq <= this.eventCursor(hostId)) return
    this.state.eventCursors[hostId] = event.seq
    if (event.kind === 'process-exited' && this.state.notices.some((item) => item.hostId === hostId && item.sessionId === event.sessionId && item.kind === 'turn-complete')) {
      this.write()
      return
    }
    const notice: Notice = { ...event, hostId, read: false }
    this.state.notices.unshift(notice)
    this.state.notices = this.state.notices.slice(0, 100)
    this.write()
    return notice
  }

  markNoticeRead(id: string): SavedState {
    const notice = this.state.notices.find((item) => item.id === id)
    if (notice) notice.read = true
    this.write()
    return this.snapshot()
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(temporary, this.path)
  }
}
