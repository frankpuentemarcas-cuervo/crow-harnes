/** BrowserWindow bounds are outer DIP sizes. Electron's work area already excludes OS bars. */
export function workspaceWindowBounds(workArea: { width: number; height: number }): { width: number; height: number; minWidth: number; minHeight: number } {
  const width = Number.isFinite(workArea.width) && workArea.width > 0 ? Math.floor(workArea.width) : 1500
  const height = Number.isFinite(workArea.height) && workArea.height > 0 ? Math.floor(workArea.height) : 920
  return { width: Math.min(1500, width), height: Math.min(920, height), minWidth: Math.min(1050, width), minHeight: Math.min(650, height) }
}

export function workspaceWindowPlacement(workArea: { x: number; y: number; width: number; height: number }): ReturnType<typeof workspaceWindowBounds> & { x: number; y: number } {
  const bounds = workspaceWindowBounds(workArea)
  return { ...bounds, x: Math.floor(workArea.x + Math.max(0, workArea.width - bounds.width) / 2), y: Math.floor(workArea.y + Math.max(0, workArea.height - bounds.height) / 2) }
}
