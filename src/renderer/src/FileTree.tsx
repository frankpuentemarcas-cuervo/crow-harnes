import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from 'lucide-react'
import type { ConnectionStatus, FileEntry } from '../../shared/types'

interface Props {
  hostId: string
  root: string
  status: ConnectionStatus
  refreshKey: number
  onOpen(path: string): void
}

export function FileTree({ hostId, root, status, refreshKey, onOpen }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (status !== 'connected') { setEntries([]); return }
    let current = true
    void window.crow.files(hostId, root, '').then((items) => { if (current) { setEntries(items); setError('') } }).catch((reason) => { if (current) setError(String(reason)) })
    return () => { current = false }
  }, [hostId, root, status, refreshKey])
  if (status !== 'connected') return <p className="files-note">Conectá el host para ver sus archivos.</p>
  if (error) return <p className="files-note error-text">{error}</p>
  return <div className="file-tree" role="tree">{entries.map((entry) => <TreeNode key={entry.path} entry={entry} depth={0} hostId={hostId} root={root} onOpen={onOpen} />)}</div>
}

function TreeNode({ entry, depth, hostId, root, onOpen }: { entry: FileEntry; depth: number; hostId: string; root: string; onOpen(path: string): void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [error, setError] = useState(false)
  async function toggle(): Promise<void> {
    if (!entry.dir) { onOpen(entry.path); return }
    if (!expanded && children.length === 0) {
      try { setChildren(await window.crow.files(hostId, root, entry.path)); setError(false) }
      catch { setError(true) }
    }
    setExpanded((current) => !current)
  }
  return <>
    <button className="file-row" role="treeitem" aria-expanded={entry.dir ? expanded : undefined} style={{ paddingLeft: `${10 + depth * 14}px` }} title={entry.path} onClick={() => void toggle()}>
      {entry.dir ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="tree-spacer" />}
      {entry.dir ? expanded ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" /> : <File size={14} className="file-icon" />}
      <span>{entry.name}</span>
    </button>
    {expanded && error && <p className="files-note">No se puede abrir esta carpeta.</p>}
    {expanded && children.map((child) => <TreeNode key={child.path} entry={child} depth={depth + 1} hostId={hostId} root={root} onOpen={onOpen} />)}
  </>
}
