import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { Code2, Eye, RefreshCw, Save } from 'lucide-react'
import type { ConnectionStatus } from '../../shared/types'
import { isMarkdownFile, MarkdownPreview, type MarkdownLinkTarget } from './MarkdownPreview.ts'
import { useConfirm } from './ConfirmDialog'

export function EditorPane({ hostId, root, path, status, onOpenLink, onDirtyChange, onBusyChange }: { hostId: string; root: string; path: string; status: ConnectionStatus; onOpenLink?(target: MarkdownLinkTarget): void; onDirtyChange?(dirty: boolean): void; onBusyChange?(busy: boolean): void }): React.JSX.Element {
  const confirm = useConfirm()
  const loadingVersion = useRef(0), saving = useRef(false), dirtyRef = useRef(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const isMarkdown = isMarkdownFile(path)
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'edit'>('preview')
  const [editorOpened, setEditorOpened] = useState(!isMarkdown)
  const [content, setContent] = useState('')
  const [hash, setHash] = useState('')
  const [preview, setPreview] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const saveRef = useRef<() => void>(() => undefined)
  const baseline = useRef('')
  const latestContent = useRef('')
  const isPreview = /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(path)

  async function load(): Promise<void> {
    if (status !== 'connected' || saving.current) return
    const version = ++loadingVersion.current
    setLoading(true)
    setError('')
    try {
      if (isPreview) {
        const data = await window.crow.previewFile(hostId, root, path)
        if (version === loadingVersion.current) setPreview(data)
      }
      else {
        const file = await window.crow.readFile(hostId, root, path)
        if (version !== loadingVersion.current) return
        baseline.current = file.content
        latestContent.current = file.content
        setContent(file.content)
        setHash(file.hash)
        setDirty(false)
        dirtyRef.current = false
      }
    } catch (reason) { if (version === loadingVersion.current) setError(String(reason)) }
    finally { if (version === loadingVersion.current) setLoading(false) }
  }

  useEffect(() => {
    if (!dirtyRef.current) void load()
    else if (status === 'connected') setError('Se conservó tu borrador al reconectar. Guardá o recargá explícitamente.')
    return () => { loadingVersion.current++ }
  }, [hostId, root, path, status])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  async function save(): Promise<void> {
    if (!dirty || status !== 'connected' || saving.current) return
    saving.current = true; setSaveBusy(true); onBusyChange?.(true)
    try {
      const submitted = latestContent.current
      const result = await window.crow.saveFile(hostId, root, path, submitted, hash)
      baseline.current = submitted
      setHash(result.hash)
      setDirty(latestContent.current !== submitted)
      dirtyRef.current = latestContent.current !== submitted
      setError('')
    } catch (reason) { setError(`${String(reason)}. Tu edición sigue abierta; recargá solo después de resolver el conflicto.`) }
    finally { saving.current = false; setSaveBusy(false); onBusyChange?.(false) }
  }
  saveRef.current = () => { void save() }

  function openMarkdownLink(target: MarkdownLinkTarget): void {
    if (dirty) { setError('Guardá los cambios antes de abrir un enlace en otra pestaña. Tu borrador sigue abierto.'); return }
    onOpenLink?.(target)
  }

  return <div className="editor-pane" onKeyDown={(event) => { if (isMarkdown && markdownMode === 'preview' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveRef.current() } }}><div className="pane-meta"><span className="editor-path">{path}</span><span className="pane-meta-right">{dirty ? 'Cambios sin guardar' : status === 'connected' ? 'Actualizado' : 'Sin conexión'}</span><button className="icon-button" title="Recargar" aria-label="Recargar" disabled={saveBusy || loading || status !== 'connected'} onClick={async () => { if (!dirty || await confirm({ message: '¿Descartar los cambios sin guardar?', accept: 'Descartar cambios', danger: true })) void load() }}><RefreshCw size={15} /></button>{!isPreview && <button className="secondary-button small-button" disabled={!dirty || saveBusy || status !== 'connected'} onClick={() => void save()}><Save size={14} aria-hidden="true" /> {saveBusy ? 'Guardando…' : 'Guardar'}</button>}</div>
    {isMarkdown && <div className="markdown-toolbar" role="group" aria-label="Modo de visualización Markdown">
      <button className="markdown-mode-button" aria-pressed={markdownMode === 'preview'} onClick={() => setMarkdownMode('preview')}><Eye size={14} aria-hidden="true" /> Vista previa</button>
      <button className="markdown-mode-button" aria-pressed={markdownMode === 'edit'} onClick={() => { setEditorOpened(true); setMarkdownMode('edit') }}><Code2 size={14} aria-hidden="true" /> Editar</button>
      <span>Markdown</span>
    </div>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading ? <div className="pane-loading">Abriendo archivo…</div> : isPreview ? <div className="preview-surface">{path.toLowerCase().endsWith('.pdf') ? <iframe title={path} src={preview} /> : <img alt={path} src={preview} />}</div> : <>
    {isMarkdown && markdownMode === 'preview' && <div className="markdown-surface" tabIndex={0}><MarkdownPreview content={content} path={path} onOpenLink={onOpenLink ? openMarkdownLink : undefined} /></div>}
    {editorOpened && <div className="editor-surface" hidden={isMarkdown && markdownMode !== 'edit'}><Editor
      path={path}
      language={isMarkdown ? 'markdown' : undefined}
      value={content}
      theme="vs-dark"
      onChange={(value) => { const next = value || ''; latestContent.current = next; setContent(next); dirtyRef.current = next !== baseline.current; setDirty(dirtyRef.current); onDirtyChange?.(dirtyRef.current) }}
      options={{ fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace', fontSize: 13, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 18 } }}
      onMount={(editor) => editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())}
    /></div>}</>}
  </div>
}
