import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownPreview, isMarkdownFile, markdownLinkTarget } from '../src/renderer/src/MarkdownPreview.ts'

const render = content => renderToStaticMarkup(createElement(MarkdownPreview, { content, path: 'docs/README.md', onOpenLink() {} }))

test('Markdown extensions are case-insensitive and do not match ordinary files', () => {
  for (const path of ['README.md', 'docs/PLAN.MD', 'notes.Markdown', 'guide.mdown']) assert.equal(isMarkdownFile(path), true)
  for (const path of ['file.txt', 'file.mdx', 'notes.md.txt']) assert.equal(isMarkdownFile(path), false)
})

test('renders semantic headings, GFM tables, task lists and code without changing source', () => {
  const content = '# Plan\n\n| Agente | Estado |\n| :--- | ---: |\n| QA | Listo |\n\n- [x] Probado\n- [ ] Pendiente\n\n**Importante** y ~~anterior~~\n\n```js\nconst n = 1 < 2\n```'
  const html = render(content)
  for (const expected of ['<h1>Plan</h1>', '<table>', '<th', '<td', 'QA', 'Listo', 'disabled=""', 'checked=""', '<strong>Importante</strong>', '<del>anterior</del>', '<pre>', 'language-js', '1 &lt; 2']) assert.ok(html.includes(expected), expected)
  assert.ok(html.includes('markdown-table-scroll'))
  assert.equal(content.startsWith('# Plan'), true)
})

test('never executes raw HTML or permits dangerous links or automatic image requests', () => {
  const html = render('<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src="https://example.com/track" onerror="alert(1)">\n\n[malicioso](javascript:alert%281%29)\n\n![Diagrama](https://example.com/track.png)\n\n![local](./image.png)')
  assert.doesNotMatch(html, /<script|<iframe|<img|javascript:|onerror=/i)
  assert.ok(html.includes('Diagrama'))
  assert.ok(html.includes('Imagen:'))
})

test('only allows intentional web navigation and project-contained relative files', () => {
  assert.deepEqual(markdownLinkTarget('https://example.com/guide', 'docs/README.md'), { kind: 'url', value: 'https://example.com/guide' })
  assert.deepEqual(markdownLinkTarget('../PLAN.MD#pasos', 'docs/README.md'), { kind: 'file', value: 'PLAN.MD' })
  assert.deepEqual(markdownLinkTarget('nested/gu%C3%ADa.md', 'docs/README.md'), { kind: 'file', value: 'docs/nested/guía.md' })
  assert.deepEqual(markdownLinkTarget('#user-content-fn-1', 'docs/README.md'), { kind: 'fragment', value: '#user-content-fn-1' })
  for (const href of ['../../secret', '%2e%2e/%2e%2e/secret', '/etc/passwd', '//example.com', 'file:///etc/passwd', 'data:text/html,evil', 'javascript:alert(1)', 'mailto:user@example.com', 'https://user:password@example.com', '../bad\\path', '%00key', '%zz']) assert.equal(markdownLinkTarget(href, 'docs/README.md'), undefined, href)
})

test('renders safe links through an explicit callback and keeps blocked links as text', () => {
  const html = render('[Manual](https://example.com) y [secreto](../../secret)')
  assert.ok(html.includes('<a href="https://example.com/"'))
  assert.ok(html.includes('secreto'))
  assert.ok(!html.includes('href="../../secret"'))
})

test('large documents offer source editing instead of parsing a huge preview', () => {
  const html = render('# fila\n'.repeat(50_000))
  assert.ok(html.includes('Editar'))
  assert.ok(!html.includes('<h1>'))
})
