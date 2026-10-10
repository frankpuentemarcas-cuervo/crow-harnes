export interface ERPTaskRecord { name: string; subject: string; description: string; project: string; status: string; priority: string; modified: string }
export interface ERPCredentials { url: string; apiKey: string; apiSecret: string }
export function validateERPURL(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Ingresá una URL HTTPS válida de ERPNext.') }
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || hostname === 'localhost' || hostname.endsWith('.localhost') || /^(127\.|0\.|169\.254\.)/.test(hostname) || hostname === '[::1]' || hostname === '[::]' || /^\[fe[89ab]/.test(hostname)) throw new Error('ERPNext requiere HTTPS, sin credenciales ni ruta en la URL.')
  return url.origin
}
export function taskText(value: string): string {
  return value.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/g, token => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' })[token]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 12000).trim()
}
export async function boundedJSON(response: Response, limit = 2_000_000): Promise<unknown> {
  if (!response.ok) { void response.body?.cancel(); throw new Error(response.status === 403 || response.status === 401 ? 'ERPNext rechazó las credenciales o permisos.' : response.status === 429 ? 'ERPNext limitó las consultas. Intentá más tarde.' : 'No se pudo consultar ERPNext.') }
  const reader = response.body?.getReader(); if (!reader) throw new Error('ERPNext entregó una respuesta inválida.')
  const chunks: Uint8Array[] = []; let bytes = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) { await reader.cancel(); throw new Error() }; chunks.push(part.value) }; return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('La respuesta excede el límite o tiene formato inválido.') }
  finally { reader.releaseLock() }
}
function record(value: unknown): ERPTaskRecord {
  if (!value || typeof value !== 'object') throw new Error('Task inválida.')
  const row = value as Record<string, unknown>
  const fields = ['name', 'subject', 'description', 'project', 'status', 'priority', 'modified'] as const
  for (const field of fields) if (row[field] != null && (typeof row[field] !== 'string' || (row[field] as string).length > (field === 'description' ? 100000 : 500))) throw new Error('Task inválida.')
  if (!row.name || !row.modified || !row.subject) throw new Error('Task incompleta.')
  if (/[\x00-\x1f\x7f-\x9f]/.test(row.name as string)) throw new Error('Identificador Task inválido.')
  return { name: row.name as string, subject: taskText(row.subject as string), description: taskText((row.description as string) || ''), project: (row.project as string) || '', status: (row.status as string) || '', priority: (row.priority as string) || '', modified: row.modified as string }
}
export class ERPNextClient {
  private credentials: ERPCredentials
  private request: typeof fetch
  private cancel?: AbortSignal
  constructor(credentials: ERPCredentials, request: typeof fetch = fetch, cancel?: AbortSignal) { this.credentials = credentials; this.request = request; this.cancel = cancel; validateERPURL(credentials.url) }
  private async get(path: string): Promise<unknown> {
    try { return await boundedJSON(await this.request(this.credentials.url + path, { method: 'GET', redirect: 'error', signal: this.cancel ? AbortSignal.any([this.cancel, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { Authorization: `token ${this.credentials.apiKey}:${this.credentials.apiSecret}`, Accept: 'application/json' } })) }
    catch (error) { if (error instanceof Error && /^(ERPNext|No se pudo consultar|La respuesta)/.test(error.message)) throw error; throw new Error('No se pudo consultar ERPNext de forma segura.') }
  }
  async identity(): Promise<string> {
    const result = await this.get('/api/method/frappe.auth.get_logged_user') as { message?: unknown }
    if (typeof result?.message !== 'string' || !result.message || result.message === 'Guest' || result.message.length > 200) throw new Error('ERPNext no confirmó la identidad.')
    return result.message
  }
  async tasks(): Promise<ERPTaskRecord[]> {
    const result: ERPTaskRecord[] = []
    for (let offset = 0; offset < 2000; offset += 100) {
      const query = new URLSearchParams({ fields: JSON.stringify(['name', 'subject', 'description', 'project', 'status', 'priority', 'modified']), limit_page_length: '100', limit_start: String(offset), order_by: 'name asc' })
      const body = await this.get('/api/resource/Task?' + query) as { data?: unknown }
      if (!Array.isArray(body?.data) || body.data.length > 100) throw new Error('ERPNext entregó una lista Task inválida.')
      result.push(...body.data.map(record)); if (body.data.length < 100) return [...new Map(result.map(task => [task.name, task])).values()]
    }
    throw new Error('Hay más de 2000 tareas. Reducí los permisos del usuario ERP para sincronizar sin omisiones.')
  }
  async task(name: string): Promise<ERPTaskRecord> { const body = await this.get('/api/resource/Task/' + encodeURIComponent(name)) as { data?: unknown }; return record(body?.data) }
}
