import { createElement, type ReactElement } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type MarkdownLinkTarget = { kind: 'url' | 'file' | 'fragment'; value: string }

export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown|mdown)$/i.test(path)
}

export function markdownLinkTarget(href: string, path: string): MarkdownLinkTarget | undefined {
  if (!href || /[\u0000-\u0020\\]/.test(href)) return
  if (href.startsWith('#')) return { kind: 'fragment', value: href }
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      if (!url.username && !url.password) return { kind: 'url', value: url.href }
    } catch { /* Invalid URLs remain plain text. */ }
    return
  }
  if (href.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(href)) return
  try {
    const relative = decodeURIComponent(href.split(/[?#]/)[0])
    if (!relative || relative.startsWith('/') || /[\u0000-\u001f\\:]/.test(relative)) return
    const parts = path.split('/').slice(0, -1)
    for (const part of relative.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') { if (!parts.length) return; parts.pop() }
      else parts.push(part)
    }
    if (parts.length) return { kind: 'file', value: parts.join('/') }
  } catch { /* Malformed percent-encoding is not a file path. */ }
}

interface Props { content: string; path: string; onOpenLink?(target: MarkdownLinkTarget): void }

// No raw HTML/MDX execution, image fetches, or direct navigation of the Electron window.
export function MarkdownPreview({ content, path, onOpenLink }: Props): ReactElement {
  if (content.length > 250_000) return createElement('p', { className: 'markdown-preview-note', role: 'status' }, 'Este documento es demasiado grande para la vista previa. Usá Editar para leer el texto completo.')
  const components: Components = {
    table: ({ node: _node, ...props }) => createElement('div', { className: 'markdown-table-scroll', tabIndex: 0, role: 'region', 'aria-label': 'Tabla Markdown' }, createElement('table', props)),
    img: ({ alt }) => createElement('span', { className: 'markdown-image-placeholder', title: 'Las imágenes no se cargan automáticamente para evitar solicitudes de red.' }, `Imagen: ${alt || 'sin descripción'} (carga automática desactivada)`),
    a: ({ children, href, id, 'aria-label': label }) => {
      const target = markdownLinkTarget(href || '', path)
      if (!target || (target.kind !== 'fragment' && !onOpenLink)) return createElement('span', { title: 'Enlace no disponible o fuera del proyecto.' }, children)
      return createElement('a', {
        id, 'aria-label': label, href: target.kind === 'file' ? href : target.value,
        onClick: target.kind === 'fragment' ? undefined : (event) => { event.preventDefault(); onOpenLink?.(target) }
      }, children)
    }
  }
  return createElement('article', { className: 'markdown-preview', 'aria-label': `Vista previa de ${path}` },
    content.trim() ? createElement(Markdown, {
      children: content, remarkPlugins: [remarkGfm], skipHtml: true, components,
      urlTransform: (url, key) => key === 'href' && markdownLinkTarget(url, path) ? url : ''
    }) : createElement('p', { className: 'markdown-preview-note' }, 'Documento vacío. Usá Editar para agregar contenido.'))
}
