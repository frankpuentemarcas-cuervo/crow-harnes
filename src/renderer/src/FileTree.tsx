import { useEffect, useState, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, Copy, Download, File, Folder, FolderOpen, RefreshCw, Upload } from 'lucide-react'
import type { ConnectionStatus, FileEntry, FileUploadResult } from '../../shared/types'

interface Props {
  hostId: string
  root: string
  projectName: string
  status: ConnectionStatus
  onOpen(path: string): void
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

function remoteAbsolutePath(root: string, relative: string): string {
  return `${root.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`
}

export function FileTree({ hostId, root, projectName, status, onOpen }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [treeError, setTreeError] = useState('')
  const [transferMessage, setTransferMessage] = useState('')
  const [transferError, setTransferError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [dropDirectory, setDropDirectory] = useState<string | null>(null)

  useEffect(() => {
    if (status !== 'connected') { setEntries([]); return }
    let current = true
    void window.crow.files(hostId, root, '').then((items) => {
      if (current) { setEntries(items); setTreeError('') }
    }).catch((reason) => { if (current) setTreeError(String(reason)) })
    return () => { current = false }
  }, [hostId, root, status, revision])

  function showUploadResult(result: FileUploadResult): void {
    if (result.canceled) return
    if (result.uploaded.length) setRevision((value) => value + 1)
    setTransferMessage(result.uploaded.length ? `${result.uploaded.length} archivo(s) subido(s) al servidor.` : '')
    setTransferError(result.failed.length ? result.failed.map((item) => `${item.name}: ${item.error}`).join(' · ') : '')
  }

  async function upload(directory: string, files?: File[]): Promise<void> {
    if (busy || status !== 'connected') return
    setBusy(true)
    setTransferError('')
    setTransferMessage(files ? `Subiendo ${files.length} archivo(s)…` : 'Seleccionando archivos…')
    try {
      let result: FileUploadResult
      if (files) {
        if (files.length > 100) throw new Error('Podés subir un máximo de 100 archivos por vez.')
        result = { uploaded: [], failed: [], canceled: false }
        for (const file of files) {
          try { result.uploaded.push(await window.crow.uploadDroppedFile(hostId, root, directory, file)) }
          catch (reason) { result.failed.push({ name: file.name, error: reason instanceof Error ? reason.message : String(reason) }) }
        }
      } else {
        result = await window.crow.pickUploadFiles(hostId, root, directory)
      }
      if (result.canceled) setTransferMessage('')
      else showUploadResult(result)
    } catch (reason) {
      setTransferMessage('')
      setTransferError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  function drop(event: DragEvent<HTMLElement>, directory: string): void {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    setDropDirectory(null)
    if (busy) { setTransferError('Esperá a que termine la transferencia actual.'); return }
    if (status !== 'connected') { setTransferError('Conectá el host antes de subir archivos.'); return }
    const files = Array.from(event.dataTransfer.files)
    if (files.length) void upload(directory, files)
  }

  async function download(path: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setTransferError('')
    setTransferMessage('Descargando archivo…')
    try {
      const saved = await window.crow.downloadFile(hostId, root, path)
      setTransferMessage(saved ? 'Archivo descargado en tu computadora.' : '')
    } catch (reason) {
      setTransferMessage('')
      setTransferError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  async function copyPath(path: string): Promise<void> {
    try {
      await window.crow.clipboardWriteText(remoteAbsolutePath(root, path))
      setTransferError('')
      setTransferMessage('Ruta del servidor copiada.')
    } catch (reason) {
      setTransferError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return <>
    <div className="files-header"><span>EXPLORADOR</span><div className="files-header-actions">
      <button className="icon-button" disabled={status !== 'connected' || busy} aria-label="Subir archivos al proyecto" title="Subir archivos desde esta computadora" onClick={() => void upload('')}><Upload size={14} /></button>
      <button className="icon-button" disabled={status !== 'connected'} aria-label="Actualizar archivos" title="Actualizar archivos" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} /></button>
    </div></div>
    <div className="files-project"><ChevronDown size={14} /><FolderOpen size={15} /><span title={root}>{projectName}</span></div>
    {transferMessage && <p className="files-feedback" role="status" aria-live="polite">{transferMessage}</p>}
    {transferError && <p className="files-feedback error-text" role="alert">{transferError}</p>}
    {status !== 'connected' ? <p className="files-note">Conectá el host para ver sus archivos.</p> : <div
      className={`file-tree${dropDirectory === '' ? ' file-tree-drop-target' : ''}`}
      role="tree"
      aria-label="Archivos del proyecto"
      onDragOver={(event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropDirectory('') } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropDirectory(null) }}
      onDrop={(event) => drop(event, '')}
    >
      {treeError ? <p className="files-note error-text">{treeError}</p> : entries.map((entry) => <TreeNode key={entry.path} entry={entry} depth={0} hostId={hostId} root={root} revision={revision} busy={busy} dropDirectory={dropDirectory} setDropDirectory={setDropDirectory} onDropFiles={drop} onOpen={onOpen} onDownload={download} onCopyPath={copyPath} />)}
      {!treeError && entries.length === 0 && <p className="files-note">Carpeta vacía. Soltá archivos aquí o usá Subir.</p>}
    </div>}
  </>
}

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  hostId: string
  root: string
  revision: number
  busy: boolean
  dropDirectory: string | null
  setDropDirectory(path: string | null): void
  onDropFiles(event: DragEvent<HTMLElement>, directory: string): void
  onOpen(path: string): void
  onDownload(path: string): Promise<void>
  onCopyPath(path: string): Promise<void>
}

function TreeNode({ entry, depth, hostId, root, revision, busy, dropDirectory, setDropDirectory, onDropFiles, onOpen, onDownload, onCopyPath }: TreeNodeProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!entry.dir || !expanded) return
    let current = true
    void window.crow.files(hostId, root, entry.path).then((items) => {
      if (current) { setChildren(items); setError(false) }
    }).catch(() => { if (current) setError(true) })
    return () => { current = false }
  }, [entry.dir, entry.path, expanded, hostId, root, revision])

  return <>
    <div className={`file-row-wrap${dropDirectory === entry.path && entry.dir ? ' file-row-drop-target' : ''}`}
      onDragOver={entry.dir ? (event) => { if (hasFiles(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDropDirectory(entry.path) } } : undefined}
      onDragLeave={entry.dir ? (event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropDirectory(null) } : undefined}
      onDrop={entry.dir ? (event) => onDropFiles(event, entry.path) : undefined}
    >
      <button className="file-row" role="treeitem" aria-expanded={entry.dir ? expanded : undefined} style={{ paddingLeft: `${10 + depth * 14}px` }} title={entry.path} onClick={() => entry.dir ? setExpanded((value) => !value) : onOpen(entry.path)}>
        {entry.dir ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="tree-spacer" />}
        {entry.dir ? expanded ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" /> : <File size={14} className="file-icon" />}
        <span>{entry.name}</span>
      </button>
      <div className="file-row-actions">
        {!entry.dir && <button className="icon-button" disabled={busy} aria-label={`Descargar ${entry.name}`} title="Descargar a esta computadora" onClick={() => void onDownload(entry.path)}><Download size={13} /></button>}
        <button className="icon-button" aria-label={`Copiar ruta de ${entry.name}`} title="Copiar ruta del servidor" onClick={() => void onCopyPath(entry.path)}><Copy size={13} /></button>
      </div>
    </div>
    {expanded && error && <p className="files-note">No se puede abrir esta carpeta.</p>}
    {expanded && children.map((child) => <TreeNode key={child.path} entry={child} depth={depth + 1} hostId={hostId} root={root} revision={revision} busy={busy} dropDirectory={dropDirectory} setDropDirectory={setDropDirectory} onDropFiles={onDropFiles} onOpen={onOpen} onDownload={onDownload} onCopyPath={onCopyPath} />)}
  </>
}
