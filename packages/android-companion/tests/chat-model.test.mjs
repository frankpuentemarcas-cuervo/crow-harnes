import test from 'node:test'
import assert from 'node:assert/strict'
import { boundChatWindow, mergeChatMessages, singleLineChatInput, splitChatMarkdown } from '../src/chat-model.mjs'

const message = (id, seq, content = id) => ({ id, seq, content, role: seq % 2 ? 'user' : 'assistant' })

test('transcript pagination merges by stable message id and sorts by sequence', () => {
  const first = [message('b', 2), message('c', 3)]
  const merged = mergeChatMessages(first, [message('a', 1), message('b', 2)])
  assert.deepEqual(merged.map(item => item.id), ['a', 'b', 'c'])
  assert.equal(mergeChatMessages(merged, [message('b', 2)]), merged)
})

test('markdown parser keeps prose and fenced code as inert text', () => {
  const html = '<img src=x onerror=alert(1)>'
  assert.deepEqual(splitChatMarkdown(`Intro\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n${html}`), [
    { type: 'paragraph', content: 'Intro' },
    { type: 'code', language: 'ts', content: 'const x = 1\n' },
    { type: 'paragraph', content: html },
  ])
  assert.deepEqual(splitChatMarkdown('unfinished ```fence'), [{ type: 'paragraph', content: 'unfinished ```fence' }])
  assert.deepEqual(splitChatMarkdown('## Resumen\n\n- uno\n- **dos**\n\n[docs](https://example.com)'), [
    { type: 'heading', level: 2, content: 'Resumen' },
    { type: 'list', ordered: false, items: ['uno', '**dos**'] },
    { type: 'paragraph', content: '[docs](https://example.com)' },
  ])
})

test('chat submissions collapse newlines into one PTY line', () => {
  assert.equal(singleLineChatInput('primera\nsegunda\r\ntercera'), 'primera segunda tercera')
  assert.equal(singleLineChatInput('  \r\n '), '')
})

test('large histories render through a bounded 200-message window in either scroll direction', () => {
  const transcript = Array.from({ length: 10000 }, (_, index) => message(`m-${index + 1}`, index + 1))
  assert.deepEqual(boundChatWindow(transcript, 200).map(item => item.seq).slice(0, 2), [9801, 9802])
  assert.deepEqual(boundChatWindow(transcript, 200, 'earliest').map(item => item.seq).slice(-2), [199, 200])
  assert.throws(() => boundChatWindow([], 0), RangeError)
})
