import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import QRCode from 'qrcode'
import { MobileDialog } from '../../src/renderer/src/MobileDialog'
import '../../src/renderer/src/styles.css'

// Synthetic invitation-shaped bytes only; this cannot pair to any Crow service.
let seed = 17
const token = (length: number): string => Array.from({ length }, () => {
  seed = (seed * 48271) % 2147483647
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[seed % 62]
}).join('')
const payload = `crow3:${token(2535)}`
const qrModuleCount = QRCode.create(payload, { errorCorrectionLevel: 'L' }).modules.size
const qrDataUrl = QRCode.toDataURL(payload, { scale: 6, margin: 4, errorCorrectionLevel: 'L' })
let expiresAt = Date.now() + 5 * 60 * 1000
let nowOffset = 0
let inviteCount = 0
Object.assign(window, {
  crow: {
    mobileStatus: async () => ({ running: false, devices: [] }),
    mobileInvite: async () => {
      inviteCount++
      expiresAt = Date.now() + 5 * 60 * 1000
      return { enrollment: { expiresAt: new Date(expiresAt).toISOString() }, qrDataUrl: await qrDataUrl, qrModuleCount, hostCount: 1, skippedHosts: [] }
    },
    mobileRevoke: async () => ({ running: false, devices: [] }),
  },
  __qrViewportQA: {
    counts: () => ({ invites: inviteCount }),
    moduleCount: qrModuleCount,
    expire: () => { nowOffset = 6 * 60 * 1000; Date.now = () => new Date().getTime() + nowOffset },
  },
})

function Fixture(): React.JSX.Element {
  return <MobileDialog projects={[{ id: 'synthetic-project', hostId: 'synthetic-host', name: 'QR validation' } as any]} hosts={[{ id: 'synthetic-host', name: 'Synthetic host' } as any]} onClose={() => {}} />
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
