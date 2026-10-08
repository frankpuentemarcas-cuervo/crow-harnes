type ShortcutEvent = Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

export function terminalClipboardAction(event: ShortcutEvent, hasSelection: boolean): 'copy' | 'paste' | null {
  if (event.type !== 'keydown' || event.altKey || event.metaKey) return null
  const key = event.key.toLowerCase()
  if (event.ctrlKey && key === 'c' && (event.shiftKey || hasSelection)) return 'copy'
  if (event.ctrlKey && key === 'v') return 'paste'
  if (!event.ctrlKey && event.shiftKey && key === 'insert') return 'paste'
  return null
}

type ClipboardInput = Pick<ClipboardEvent, 'clipboardData' | 'preventDefault' | 'stopPropagation'>

// Menu/context-menu actions can emit copy/paste without any keydown in xterm.
export function copyTerminalClipboardEvent(event: ClipboardInput, selected: string): boolean {
  if (!selected || !event.clipboardData) return false
  event.clipboardData.setData('text/plain', selected)
  event.preventDefault()
  event.stopPropagation()
  return true
}

export function pasteTerminalClipboardEvent(event: ClipboardInput, paste: (text: string) => void): boolean {
  if (!event.clipboardData) return false
  event.preventDefault()
  event.stopPropagation()
  const text = event.clipboardData.getData('text/plain')
  if (text) paste(text)
  return true
}
