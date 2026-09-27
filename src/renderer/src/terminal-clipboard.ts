type ShortcutEvent = Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

export function terminalClipboardAction(event: ShortcutEvent, hasSelection: boolean): 'copy' | 'paste' | null {
  if (event.type !== 'keydown' || event.altKey || event.metaKey) return null
  const key = event.key.toLowerCase()
  if (event.ctrlKey && key === 'c' && (event.shiftKey || hasSelection)) return 'copy'
  if (event.ctrlKey && key === 'v') return 'paste'
  if (!event.ctrlKey && event.shiftKey && key === 'insert') return 'paste'
  return null
}
