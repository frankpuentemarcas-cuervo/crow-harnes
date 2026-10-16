export function mergeChatMessages(previous, incoming) {
  const byId = new Map(previous.map(message => [message.id, message]))
  let changed = false
  for (const message of incoming) {
    const old = byId.get(message.id)
    if (!old || old.content !== message.content || old.seq !== message.seq) changed = true
    byId.set(message.id, message)
  }
  return changed ? [...byId.values()].sort((left, right) => left.seq - right.seq) : previous
}

export function boundChatWindow(messages, maximum, edge = 'latest') {
  if (!Number.isInteger(maximum) || maximum < 1) throw new RangeError('maximum must be a positive integer')
  if (messages.length <= maximum) return messages
  return edge === 'earliest' ? messages.slice(0, maximum) : messages.slice(-maximum)
}

/** A chat send is one PTY submission, never a sequence of commands. */
export function singleLineChatInput(value) {
  return value.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').trim()
}

/** Unknown telemetry is not a permission failure. Only confirmed work blocks
 * another turn; the composer remains editable while connection/work settles. */
export function chatInputAllowed(session, capabilities, connected, awaiting, override = false) {
  return !!(session.canOperate && !session.readOnly && capabilities.input && session.state === 'running' && connected && !awaiting && (session.agentState !== 'working' || override))
}

export function confirmedChatEcho(outgoing, messages) {
  if (!outgoing) return false
  return messages.some(item => item.role === 'user' && item.seq > outgoing.afterSeq && singleLineChatInput(item.content) === outgoing.content)
}

export function definiteChatSendFailure(reason) {
  return String(reason instanceof Error ? reason.message : reason).includes('No se envió el texto.')
}

/** Correlate only after the submitted user text appears in durable history.
 * An older assistant answer loaded during reconnect is not a new reply. */
export function chatReplyProgress(submission, messages) {
  let userSeq = submission.userSeq || 0
  if (!userSeq) userSeq = messages.find(item => item.role === 'user' && item.seq > submission.afterSeq && singleLineChatInput(item.content) === submission.content)?.seq || 0
  return { ...submission, userSeq, answered: !!userSeq && messages.some(item => item.role === 'assistant' && item.seq > userSeq) }
}

function splitTextBlocks(content) {
  const blocks = []
  let paragraph = [], list = null
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', content: paragraph.join('\n') })
    paragraph = []
  }
  const flushList = () => {
    if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) { flushParagraph(); flushList(); continue }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph(); flushList()
      blocks.push({ type: 'heading', level: heading[1].length, content: heading[2] })
      continue
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (unordered || ordered) {
      flushParagraph()
      const isOrdered = !!ordered
      if (list && list.ordered !== isOrdered) flushList()
      if (!list) list = { ordered: isOrdered, items: [] }
      list.items.push((unordered || ordered)[1])
      continue
    }
    flushList(); paragraph.push(line)
  }
  flushParagraph(); flushList()
  return blocks
}

/** Parse a small, inert Markdown subset. Consumers render only text nodes and
 * explicitly validated links; transcript content is never interpreted as HTML. */
export function splitChatMarkdown(content) {
  const blocks = []
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g
  let cursor = 0
  for (const match of content.matchAll(fence)) {
    const offset = match.index ?? cursor
    if (offset > cursor) blocks.push(...splitTextBlocks(content.slice(cursor, offset)))
    blocks.push({ type: 'code', language: match[1].trim(), content: match[2] })
    cursor = offset + match[0].length
  }
  if (cursor < content.length || blocks.length === 0) blocks.push(...splitTextBlocks(content.slice(cursor)))
  if (!blocks.length) blocks.push({ type: 'paragraph', content: '' })
  return blocks
}
