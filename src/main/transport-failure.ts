export function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
}
