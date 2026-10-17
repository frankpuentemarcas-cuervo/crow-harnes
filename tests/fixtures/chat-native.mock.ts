// Isolated UI regression data. Never loaded by the production app.
let messages = Array.from({ length: 340 }, (_, index) => ({ id: `message-${index + 1}`, sessionId: 'a'.repeat(32), seq: index + 1, role: index % 2 ? 'assistant' : 'user', content: index === 339 ? 'LATEST ANSWER\n' + 'A long answer that must remain readable.\n'.repeat(35) : `Message ${index + 1}`, createdAt: new Date().toISOString() }))
const listeners = new Set<(event: any) => void>()
let streamId = '', acknowledge: (() => void) | undefined, sent = '', state = 'unknown'
let hold = false, held: (() => void)[] = [], calls = 0, sends = 0, copied = ''
const operations = new Map<string, any>()
const frame = (value: any) => { for (const listener of listeners) listener({ profileId: 'qa', connectionId: streamId, data: JSON.stringify(value) }) }
const info = () => ({ id: 'a'.repeat(32), agent: 'claude', state: 'running', canOperate: true, agentState: state, seq: 0, chatAvailable: true })
export const Gateway = {
  async addListener(_: string, listener: (event: any) => void) { listeners.add(listener); return { async remove() { listeners.delete(listener) } } },
  async openStream(input: any) { streamId = input.connectionId; setTimeout(() => { frame({ type: 'ready', streamId: 'native-server' }); frame({ type: 'state', info: info() }) }, 10) },
  async closeStream() {},
}
export const App = { async addListener() { return { async remove() {} } } }
export const Clipboard = { async write(input: { string: string }) { copied = input.string } }
export async function api(_profile: string, path: string, method = 'GET', body?: any) {
  if (path === '/api/v2/chat-submit' && method === 'POST') {
    sends++; sent = body.text
    const operation = { operationId: `op-${body.requestId}`, requestId: body.requestId, sessionId: body.sessionId, status: 'pending' }
    operations.set(body.requestId, operation)
    return await new Promise(resolve => { acknowledge = () => { operation.status = 'written'; resolve({ ...operation }) } })
  }
  if (path.startsWith('/api/v2/chat-submit?')) {
    const q = new URL(path, 'https://qa.invalid').searchParams
    const operation = operations.get(q.get('requestId'))
    if (!operation) throw new Error('HTTP 404')
    return { ...operation }
  }
  calls++
  const q = new URL(path, 'https://qa.invalid').searchParams
  const after = Number(q.get('after') || 0), before = Number(q.get('before') || 0), limit = Number(q.get('limit') || 100)
  const filtered = messages.filter(m => (!after || m.seq > after) && (!before || m.seq < before))
  const page = after ? filtered.slice(0, limit) : filtered.slice(-limit)
  const result = { messages: page, hasMore: filtered.length > limit, nextBefore: page[0]?.seq || 0 }
  if (hold) await new Promise<void>(resolve => held.push(resolve))
  await new Promise(resolve => setTimeout(resolve, 15))
  return result
}
function append(role: string, content: string) { const seq = messages.length + 1; messages = [...messages, { id: `message-${seq}`, sessionId: 'a'.repeat(32), seq, role, content, createdAt: new Date().toISOString() }] }
export const qa = {
  info, calls: () => calls, sends: () => sends, sent: () => sent, copied: () => copied,
  ack() { acknowledge?.(); acknowledge = undefined },
  activity(value: string) { state = value; frame({ type: 'state', info: info() }) },
  accepted() { append('user', sent); for (const operation of operations.values()) operation.status = 'accepted'; state = 'working'; frame({ type: 'state', info: info() }) },
  complete(text: string) { append('assistant', text); state = 'completed'; frame({ type: 'state', info: info() }) },
  hold() { hold = true }, release() { hold = false; for (const resolve of held) resolve(); held = [] },
}
