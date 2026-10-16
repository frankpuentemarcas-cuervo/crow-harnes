export const READ_TIMEOUT_MS = 15000

// Only reads are cancellable/retriable. Never wrap a mutation with this helper.
export function boundedRead(start, cancel, signal, timeoutMs = READ_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false, started = false, timer
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted)
      if (error) reject(error); else resolve(value)
    }
    const stop = error => {
      if (settled) return
      if (started) { try { Promise.resolve(cancel()).catch(() => {}) } catch { /* cancellation is best effort */ } }
      finish(error)
    }
    const aborted = () => stop(new Error('Lectura cancelada: cambió el equipo o la app pasó a segundo plano.'))
    if (signal?.aborted) { aborted(); return }
    signal?.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => stop(new Error('Sin respuesta de Crow en 15 segundos. Volvé a intentar; el vínculo se conserva.')), timeoutMs)
    started = true
    try { Promise.resolve(start()).then(value => finish(null, value), error => finish(error)) } catch (error) { finish(error) }
  })
}

export function revokedConnection(text) { return /revocado|vencido|forgotten|rechazó la autenticación del dispositivo|HTTP 401/i.test(text) }
export function retryableConnection(text) { return !revokedConnection(text) && /sin conexión|sin respuesta|desconectad|network|timed out/i.test(text) }

// Explicitly selected host wins. Never guess between multiple stored identities.
export function sessionProfile(profiles, selected, hostId) {
  if (!selected || selected.mobileHostId === hostId) return selected
  const candidates = profiles.filter(item => item.mobileHostId === hostId && item.mobileHostId !== 'windows' && item.device.projectIds.some(id => selected.device.projectIds.includes(id)))
  return candidates.length === 1 ? candidates[0] : selected
}
export function fallbackProfile(profiles, selected) {
  if (selected?.mobileHostId !== 'windows') return undefined
  return profiles.find(item => item.mobileHostId && item.mobileHostId !== 'windows' && item.device.projectIds.some(id => selected.device.projectIds.includes(id)) && profiles.filter(other => other.mobileHostId === item.mobileHostId).length === 1)
}
