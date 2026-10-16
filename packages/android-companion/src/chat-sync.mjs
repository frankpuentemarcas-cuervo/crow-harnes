/** Serial, coalescing read-only sync. Never retries a terminal mutation. */
export function createChatSync({ read, accept, error, loading = (_value, _mode) => {} }) {
  let disposed = false, running = null, pending = null
  const queue = mode => {
    if (pending === 'initial' || (mode === 'older' && running)) return
    pending = mode === 'initial' || !pending ? mode : pending
  }
  return {
    request(mode = 'newer') {
      if (disposed) return Promise.resolve()
      queue(mode)
      if (running) return running
      running = (async () => {
        let pages = 0
        while (!disposed && pending) {
          const mode = pending; pending = null
          loading(true, mode)
          try {
            const page = await read(mode)
            if (disposed) return
            accept(page, mode)
            // Drain a backlog immediately, but prefer a fresh tail over walking
            // thousands of records that the bounded mobile view cannot display.
            if (mode === 'newer' && page.hasMore && page.messages.length) queue(++pages < 2 ? 'newer' : 'initial')
          } catch (reason) { if (!disposed) error(reason) }
          finally { if (!disposed) loading(false, mode) }
        }
      })().finally(() => { running = null })
      return running
    },
    dispose() { disposed = true; pending = null },
  }
}
