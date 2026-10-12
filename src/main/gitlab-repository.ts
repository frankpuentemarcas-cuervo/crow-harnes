import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isIP } from 'node:net'
import type { GitLabRepositoryContext, GitLabRepositoryFiles, Project } from '../shared/types'

export interface SecretEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Stores only encrypted, per-project read-only credentials outside state.json. */
export class GitLabTokenStore {
  private readonly path: string
  private readonly encryption: SecretEncryption
  constructor(directory: string, encryption: SecretEncryption) { this.encryption = encryption; this.path = join(directory, 'gitlab-tokens.enc') }
  private load(): Record<string, string> {
    if (!existsSync(this.path)) return {}
    if (!this.encryption.isEncryptionAvailable()) throw new Error('El almacenamiento seguro de Windows no está disponible.')
    try { return JSON.parse(this.encryption.decryptString(readFileSync(this.path))) as Record<string, string> }
    catch { throw new Error('No se pudo desbloquear la credencial GitLab guardada.') }
  }
  get(projectId: string): string | undefined { return this.load()[projectId] }
  save(projectId: string, token: string): void {
    if (typeof token !== 'string' || token.length > 8192 || /[\r\n]/.test(token)) throw new Error('La clave de acceso GitLab no es válida.')
    if (!this.encryption.isEncryptionAvailable()) throw new Error('El almacenamiento seguro de Windows no está disponible.')
    const next = { ...this.load(), [projectId]: token.trim() }
    if (!next[projectId]) delete next[projectId]
    this.persist(next)
  }
  remove(projectId: string): void { const next = this.load(); delete next[projectId]; this.persist(next) }
  private persist(value: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    try { writeFileSync(temporary, this.encryption.encryptString(JSON.stringify(value)), { mode: 0o600 }); renameSync(temporary, this.path) }
    finally { rmSync(temporary, { force: true }) }
  }
}

function repositoryLocation(project: Project): { base: string; path: string } {
  if (!project.gitlabUrl || !project.allowGitLabRead) throw new Error('Este proyecto no tiene permiso para leer su repositorio GitLab.')
  let repository: URL
  try { repository = new URL(project.gitlabUrl) } catch { throw new Error('La URL GitLab del proyecto no es válida.') }
  // The user explicitly configures this origin and separately enables repository reading.
  // Pin every request to that HTTPS origin and reject redirects so a token cannot be forwarded elsewhere.
  if (repository.protocol !== 'https:' || !repository.hostname || isIP(repository.hostname.replace(/^\[|\]$/g, '')) || repository.hostname === 'localhost' || repository.hostname.endsWith('.localhost') || repository.username || repository.password || repository.search || repository.hash) throw new Error('Ingresá una URL de GitLab con dominio HTTPS, sin credenciales ni parámetros.')
  const path = repository.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('La ruta del proyecto GitLab no es válida.')
  return { base: `${repository.origin}/api/v4`, path }
}

async function gitlabRequest(endpoint: string, token: string | undefined, request: typeof fetch): Promise<string> {
  try {
    const response = await request(endpoint, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json', ...(token ? { 'PRIVATE-TOKEN': token } : {}) } })
    const length = Number(response.headers.get('content-length') || 0)
    if (length > 131072) throw new Error('La respuesta de GitLab supera el límite permitido.')
    const raw = await response.text()
    if (raw.length > 131072) throw new Error('La respuesta de GitLab supera el límite permitido.')
    if (!response.ok) throw new Error(response.status === 404 ? 'No se encontró el archivo o no hay acceso al repositorio.' : response.status === 401 || response.status === 403 ? 'GitLab rechazó el token. Usá un token de solo lectura con read_repository o read_api.' : 'GitLab no pudo entregar el archivo.')
    return raw
  } catch (error) {
    if (error instanceof Error && /GitLab|token|límite|permiso|seguridad|archivo/.test(error.message)) throw error
    throw new Error('No se pudo consultar GitLab. Revisá conexión, permisos y token.')
  }
}

export function isAllowedGitLabSourcePath(path: string): boolean {
  if (path.length > 300 || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return false
  if (/(^|\/)(\.git|\.env[^/]*|node_modules|vendor|dist|build|coverage|\.next|target|\.idea|\.vscode)(\/|$)/i.test(path)) return false
  if (/(secret|credential|token|private[-_]?key|\.pem$|\.p12$|\.key$|\.lock$)/i.test(path)) return false
  return /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|go|py|java|kt|php|rb|rs|cs|sql|toml|ya?ml|html|css|scss|sh)$/i.test(path) || /(^|\/)(package\.json|composer\.json|tsconfig\.json)$/i.test(path)
}

export async function listGitLabProjectFiles(project: Project, token?: string, request: typeof fetch = fetch): Promise<GitLabRepositoryFiles> {
  const { base, path } = repositoryLocation(project)
  const endpoint = `${base}/projects/${encodeURIComponent(path)}/repository/tree?recursive=true&per_page=100&page=1&ref=HEAD`
  let body: unknown
  try { body = JSON.parse(await gitlabRequest(endpoint, token, request)) } catch (error) { if (error instanceof Error && /GitLab|token|límite|permiso|seguridad|archivo/.test(error.message)) throw error; throw new Error('GitLab devolvió un árbol de archivos inválido.') }
  if (!Array.isArray(body)) throw new Error('GitLab devolvió un árbol de archivos inválido.')
  const files = body.filter(item => item && item.type === 'blob' && typeof item.path === 'string' && isAllowedGitLabSourcePath(item.path)).map(item => item.path as string).slice(0, 100)
  return { projectId: project.id, files }
}

export async function readGitLabProjectFiles(project: Project, paths: string[], token?: string, request: typeof fetch = fetch): Promise<GitLabRepositoryContext[]> {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 5 || paths.some(path => typeof path !== 'string' || !isAllowedGitLabSourcePath(path)) || new Set(paths).size !== paths.length) throw new Error('Elegí entre uno y cinco archivos de texto válidos.')
  const available = await listGitLabProjectFiles(project, token, request)
  if (paths.some(path => !available.files.includes(path))) throw new Error('Uno de los archivos ya no está disponible o no está permitido.')
  const { base, path: projectPath } = repositoryLocation(project), result: GitLabRepositoryContext[] = []
  let total = 0
  for (const fileName of paths) {
    const endpoint = `${base}/projects/${encodeURIComponent(projectPath)}/repository/files/${encodeURIComponent(fileName)}?ref=HEAD`
    let value: { content?: unknown; encoding?: unknown }
    try { value = JSON.parse(await gitlabRequest(endpoint, token, request)) as typeof value } catch (error) { if (error instanceof Error && /GitLab|token|límite|permiso|seguridad|archivo/.test(error.message)) throw error; throw new Error('GitLab devolvió un archivo inválido.') }
    if (value.encoding !== 'base64' || typeof value.content !== 'string' || value.content.length > 20000) throw new Error('El archivo seleccionado no es texto o supera el límite permitido.')
    const content = Buffer.from(value.content, 'base64').toString('utf8').replace(/\u0000/g, '').slice(0, 4000)
    if (!content.trim()) continue
    total += content.length
    if (total > 12000) throw new Error('La selección supera 12.000 caracteres. Elegí menos archivos.')
    result.push({ projectId: project.id, fileName, content })
  }
  return result
}
