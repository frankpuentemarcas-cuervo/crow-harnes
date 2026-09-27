const newerRuntimeRoutes = [
  /^GET \/api\/host\/metrics$/,
  /^GET \/api\/hooks$/,
  /^PUT \/api\/hooks$/,
  /^DELETE \/api\/sessions\/[0-9a-f]{32}$/,
  /^POST \/api\/sessions\/[0-9a-f]{32}\/wake$/
]

export function remoteApiError(status: number, body: string, method: string, path: string): Error {
  if (status === 404 && body.trim() === '404 page not found' && newerRuntimeRoutes.some((route) => route.test(`${method} ${path}`))) {
    return new Error('El servicio crowd de Linux está desactualizado. Actualizá y reiniciá crowd en este host para usar esta función.')
  }
  return new Error(body.trim() || `Error HTTP ${status}`)
}
