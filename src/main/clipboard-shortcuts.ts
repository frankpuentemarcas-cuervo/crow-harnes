type Input = { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }

// Let the renderer choose between copying a terminal selection and sending ^C.
// Do not preventDefault: inputs/editors still need Chromium's native clipboard.
export function ignoreClipboardMenuShortcut(input: Input): boolean {
  if (!['keyDown', 'keyUp'].includes(input.type) || input.alt || input.meta) return false
  const key = input.key.toLowerCase()
  return (input.control && (key === 'c' || key === 'v')) || (!input.control && input.shift && key === 'insert')
}
