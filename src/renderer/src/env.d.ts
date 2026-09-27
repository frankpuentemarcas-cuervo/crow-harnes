import type { CrowAPI } from '../../shared/types'

declare global {
  interface Window { crow: CrowAPI }
}

export {}
