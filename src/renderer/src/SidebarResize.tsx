import { useRef } from 'react'
import { sidebarWidth } from './ui-continuity'

export function SidebarResize({ width, onChange }: { width: number; onChange(width: number): void }): React.JSX.Element {
  const drag = useRef<{ start: number; width: number } | null>(null)
  return <div className="sidebar-resize" role="separator" aria-label="Ancho del panel lateral" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={560} aria-valuenow={width} tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { start: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={event => { if (drag.current) onChange(sidebarWidth(Math.max(280, drag.current.width + event.clientX - drag.current.start))) }}
    onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
    onDoubleClick={() => onChange(280)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      onChange(event.key === 'Home' ? 280 : event.key === 'End' ? 560 : sidebarWidth(Math.max(280, width + (event.key === 'ArrowRight' ? 20 : -20))))
    }} />
}
