import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { dirname, join } from 'node:path'

const installationIdPattern = /^[0-9a-f]{32}$/

/** Stable local partition key: one per Crow user-data profile, never a MAC address. */
export function getInstallationId(path = join(app.getPath('userData'), 'installation-id')): string {
  mkdirSync(dirname(path), { recursive: true })
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (!installationIdPattern.test(existing)) throw new Error('La identidad local de Crow está dañada; revisá el archivo de identidad.')
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const id = randomBytes(16).toString('hex')
  let fd: number
  try { fd = openSync(path, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = readFileSync(path, 'utf8').trim()
    if (!installationIdPattern.test(existing)) throw new Error('La identidad local de Crow está dañada; revisá el archivo de identidad.')
    return existing
  }
  try { writeFileSync(fd, id, 'utf8'); } finally { closeSync(fd) }
  return id
}
