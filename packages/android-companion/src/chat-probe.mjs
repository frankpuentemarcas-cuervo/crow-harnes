import { chatReplyProgress } from './chat-model.mjs'

export const CHAT_PROBE_TIMEOUT_MS = 90000

/** @typedef {{id:string, token:string, prompt:string, afterSeq:number, userSeq:number, startedAt:number, writtenAt:number|null, acceptedAt:number|null, answeredAt:number|null, finishedAt:number|null, sawReply:boolean, sendError:boolean, outcome:string}} ChatProbe */

/** One benign message, sent by the ordinary Chat composer. No commands/retries. */
export function createChatProbe(id, afterSeq, now) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error('ID de prueba inválido.')
  const token = `CROW_OK_${id}`
  return /** @type {ChatProbe} */ ({ id, token, prompt: `Prueba de conexión de Crow. No uses herramientas ni ejecutes comandos. Respondé únicamente con: ${token}`, afterSeq, userSeq: 0, startedAt: now, writtenAt: null, acceptedAt: null, answeredAt: null, finishedAt: null, sawReply: false, sendError: false, outcome: 'running' })
}

export function advanceChatProbe(probe, event, now) {
  if (event.type === 'written' && probe.writtenAt === null) return { ...probe, writtenAt: now }
  if (event.type === 'send-error') return { ...probe, sendError: true }
  if (probe.outcome !== 'running') return probe
  if (event.type === 'cancelled' || event.type === 'rejected') return { ...probe, outcome: event.type === 'rejected' ? 'not-sent' : 'cancelled', finishedAt: now }
  if (event.type === 'timeout') return { ...probe, outcome: !probe.userSeq ? 'acceptance-timeout' : probe.sawReply ? 'unexpected-response' : 'response-timeout', finishedAt: now }
  if (event.type !== 'history') return probe
  const progress = chatReplyProgress({ content: probe.prompt, afterSeq: probe.afterSeq, userSeq: probe.userSeq }, event.messages)
  if (!progress.userSeq) return probe
  const replies = event.messages.filter(item => item.role === 'assistant' && item.seq > progress.userSeq)
  const passed = replies.some(item => item.content.trim() === probe.token)
  return { ...probe, userSeq: progress.userSeq, acceptedAt: probe.acceptedAt ?? now, sawReply: probe.sawReply || replies.length > 0, answeredAt: passed ? now : null, finishedAt: passed ? now : null, outcome: passed ? 'passed' : 'running' }
}

/** Explicit allowlist: no profile, endpoint, auth, prompt, transcript or raw error. */
export function chatProbeReport(probe) {
  const elapsed = end => end === null ? null : Math.max(0, Math.round(end - probe.startedAt))
  return { schema: 1, testId: probe.id, outcome: probe.outcome, writtenMs: elapsed(probe.writtenAt), acceptedMs: elapsed(probe.acceptedAt), responseMs: elapsed(probe.answeredAt), totalMs: elapsed(probe.finishedAt), sendError: probe.sendError }
}
