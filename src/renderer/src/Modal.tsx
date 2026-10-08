import { useEffect, useRef, type ReactNode } from 'react'

// All dialogs live in the browser's top layer: background terminals cannot steal focus.
export function Modal({ children, titleId, onClose, busy = false, className = '', initialFocus, selectInitialText = false }: {
  children: ReactNode; titleId: string; onClose(): void; busy?: boolean; className?: string; initialFocus?: string; selectInitialText?: boolean
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    if (initialFocus) {
      const target = element.querySelector<HTMLElement>(initialFocus)
      target?.focus()
      if (selectInitialText && target instanceof HTMLInputElement) target.select()
    }
    return () => {
      element.close()
      const current = document.activeElement
      // Do not steal focus from a newer dialog or a field the user already selected.
      if (current && current !== document.body && current !== element && !element.contains(current)) return
      const target = previous?.isConnected && !previous.closest('[hidden], [inert]') ? previous : document.querySelector<HTMLElement>('.app-shell')
      target?.focus({ preventScroll: true })
    }
  }, [])
  return <dialog ref={dialog} className={`dialog-card app-dialog ${className}`} aria-labelledby={titleId} onCancel={event => {
    event.preventDefault()
    if (!busy) onClose()
  }}>{children}</dialog>
}
