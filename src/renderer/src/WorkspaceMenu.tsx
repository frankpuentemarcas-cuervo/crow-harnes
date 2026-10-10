import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** Click/keyboard accessible, outside-click/Escape dismissible secondary tools. */
export function WorkspaceMenu({ label, trigger, children, className = '' }: { label: string; trigger: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div className={`workspace-menu ${className}`} ref={root}>
    <button ref={button} className="workspace-menu-trigger" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{trigger}</button>
    {open && <div id={id} className="workspace-menu-content" role="region" aria-label={label} onClick={event => {
      // Focus the trigger before a modal mounts, so its close returns here.
      if ((event.target as HTMLElement).closest('button')) { button.current?.focus(); setOpen(false) }
    }}>{children}</div>}
  </div>
}
