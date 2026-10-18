// Real MobileDialog + Modal + product styles in hidden Electron. All invitation
// bytes are synthetic, and no installed app profile, production service or credential is used.
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const temp = await mkdtemp(join(tmpdir(), 'crow-qr-viewport-'))
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const evidenceRoot = process.env.CROW_QR_EVIDENCE_DIR || join(tmpdir(), 'crow-qr-evidence')
const evidenceDir = join(evidenceRoot, `qr-viewport-${runId}`)
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [react()],
  // Use Vite's normal localhost dev port (5173) with strictPort disabled, instead
  // of deriving a fixed pid-based port that can land in Windows' excluded high-port
  // ranges and fail with EACCES on hosted runners. On a collision Vite increments to
  // the next free port. Electron dials the actual bound port from httpServer.address().
  server: { host: '127.0.0.1', port: 5173, strictPort: false, watch: { ignored: ['**/android/**', '**/dist/**'] } },
})

await server.listen()
await mkdir(evidenceDir, { recursive: true })
const electronScript = join(temp, 'main.cjs')
await writeFile(electronScript, `
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
app.setPath('userData', ${JSON.stringify(join(temp, 'profile'))})
app.disableHardwareAcceleration()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async (js, expression, timeout=6000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try { if (await js(expression)) return } catch (error) { console.error('wait expression failed:',expression,error); throw error }
    await delay(25)
  }
  throw new Error('Timed out waiting for '+expression)
}
const geometry = () => document => {
  const dialog = document.querySelector('.app-dialog')
  const scan = document.querySelector('.mobile-qr-scan')
  const img = document.querySelector('.mobile-qr-scan img')
  const close = document.querySelector('.dialog-heading [aria-label="Cerrar"]')
  const rect = element => { const r=element.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height} }
  const css = element => getComputedStyle(element)
  return {
    viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screen:[screen.width,screen.height]},
    dialog:{rect:rect(dialog),client:[dialog.clientWidth,dialog.clientHeight],scroll:[dialog.scrollWidth,dialog.scrollHeight],inlineStyle:dialog.getAttribute('style'),computedWidth:css(dialog).width,computedMaxWidth:css(dialog).maxWidth,containsScan:dialog.contains(scan)},
    scan:{rect:rect(scan),client:[scan.clientWidth,scan.clientHeight],scroll:[scan.scrollWidth,scan.scrollHeight],padding:[css(scan).paddingTop,css(scan).paddingRight,css(scan).paddingBottom,css(scan).paddingLeft],position:css(scan).position},
    image:{rect:rect(img),natural:[img.naturalWidth,img.naturalHeight],rendering:css(img).imageRendering,srcLength:img.src.length},
    close:rect(close),expiry:document.querySelector('.mobile-qr-scan strong')?.textContent,expiryRect:rect(document.querySelector('.mobile-qr-scan strong')),
    focus:{tag:document.activeElement?.tagName,aria:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.textContent?.trim(),inside:dialog.contains(document.activeElement)},
    documentScroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
  }
}
const cases = JSON.parse(process.env.CROW_QR_CASES)
const port = Number(process.env.CROW_QR_PORT)
app.whenReady().then(async () => {
  for (const item of cases) {
    const width = Math.round(item.physicalWidth/item.dpr), height=Math.round(item.physicalHeight/item.dpr)
    const w = new BrowserWindow({show:false,frame:false,useContentSize:true,width,height,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,zoomFactor:1}})
    w.webContents.on('console-message', (event, level, message, line, source) => { if (level >= 2 || event.level >= 2) console.error('Renderer:', message || event.message, line, source) })
    w.webContents.on('render-process-gone', (_event, details) => console.error('Renderer process exited:', details))
    const js = code => w.webContents.executeJavaScript(code)
    await w.loadURL('http://127.0.0.1:'+port+'/tests/fixtures/mobile-qr-viewport-ui.html')
    await wait(js,'document.querySelector(".dialog-card") && document.querySelector(".dialog-card").open')
    const moduleCount = await js('__qrViewportQA.moduleCount')
    await js('document.querySelector(".primary-button").click()')
    await wait(js,'Boolean(document.querySelector(".mobile-qr-scan img"))')
    await delay(300)
    const countBefore=await js('__qrViewportQA.counts().invites')
    await wait(js,'Boolean(document.querySelector(".mobile-qr-scan img"))')
    let initial
    try { initial=await js('('+geometry().toString()+')(document)') } catch (error) { console.error('GEOMETRY EVALUATION FAILED', error); throw error }
    await js('window.__qrViewportQA.initialImageSrc=document.querySelector(".mobile-qr-scan img").src; true')
    const evidence='qr-viewport-'+item.physicalWidth+'x'+item.physicalHeight+'-dpr'+String(item.dpr).replace('.','_')
    fs.writeFileSync(path.join(${JSON.stringify(evidenceDir)},evidence+'.json'),JSON.stringify({...initial,expectedPhysical:item},null,2))
    fs.writeFileSync(path.join(${JSON.stringify(evidenceDir)},evidence+'.png'),(await w.webContents.capturePage()).toPNG())
    assert.ok(Math.abs(initial.viewport.dpr-item.dpr)<0.01, 'Electron did not apply requested device scale factor: '+JSON.stringify(initial.viewport))
    assert.equal(await js('document.querySelector(".mobile-qr-scan img").naturalWidth'),1038,'synthetic dense QR should retain 6px/module + 4-module quiet zone source pixels')
    assert.ok(initial.image.rect.width>0 && initial.image.rect.height>0)
    assert.equal(initial.image.rendering,'pixelated')
    assert.ok(Math.abs(initial.image.rect.width/(moduleCount+8)*item.dpr-Math.round(initial.image.rect.width/(moduleCount+8)*item.dpr))<0.02,'module grid must land on integer physical display pixels')
    assert.ok(initial.dialog.containsScan,'focus view must remain inside the existing native modal')
    assert.ok(initial.image.rect.x>=initial.scan.rect.x+parseFloat(initial.scan.padding[3])-1,'QR left edge escapes scan content')
    assert.ok(initial.image.rect.right<=initial.scan.rect.right-parseFloat(initial.scan.padding[1])+1,'QR right edge escapes scan content')
    assert.ok(initial.image.rect.y>=initial.scan.rect.y-1 && initial.image.rect.bottom<=initial.scan.rect.bottom+1,'QR escapes scan focus view')
    assert.ok(initial.image.rect.x>=0 && initial.image.rect.right<=initial.viewport.width,'QR escapes viewport horizontally')
    assert.ok(initial.image.rect.y>=0 && initial.image.rect.bottom<=initial.viewport.height,'QR escapes viewport vertically')
    assert.ok(initial.close.x>=0 && initial.close.right<=initial.viewport.width && initial.close.y>=0 && initial.close.bottom<=initial.viewport.height,'close control is off-screen')
    assert.ok(initial.expiryRect.x>=0 && initial.expiryRect.right<=initial.viewport.width && initial.expiryRect.y>=0 && initial.expiryRect.bottom<=initial.viewport.height,'expiry is off-screen')
    assert.match(initial.expiry,/vence/i,'expiry is visible beside the large QR')
    assert.equal(initial.focus.text,'Volver a opciones','focus should move into focused scan view')
    assert.deepEqual(initial.scan.scroll,[initial.scan.client[0],initial.scan.client[1]],'focused QR view should not need horizontal or vertical scrolling')
    assert.ok(initial.documentScroll[0]<=initial.viewport.width,'document should not scroll horizontally')
    await js('document.querySelector(".dialog-heading .secondary-button").click()')
    await wait(js,'Boolean(document.querySelector(".mobile-qr-panel button"))')
    assert.equal(await js('__qrViewportQA.counts().invites'),countBefore,'returning to options must not regenerate invitation')
    await js('document.querySelector(".mobile-qr-panel button").click()')
    await wait(js,'Boolean(document.querySelector(".mobile-qr-scan img"))')
    assert.equal(await js('document.querySelector(".mobile-qr-scan img").src===window.__qrViewportQA.initialImageSrc'),true,'same QR image must survive focus-mode round trip')
    await js('__qrViewportQA.expire()')
    await wait(js,'!document.querySelector(".mobile-qr-scan img") && document.body.textContent.includes("El QR venció")',5000)
    const focus=await js('(()=>{const d=document.querySelector(".app-dialog"),e=document.activeElement;return {inside:d.contains(e),body:e===document.body,visible:!!e?.getClientRects().length,disabled:!!e?.disabled,tag:e?.tagName}})()')
    assert.ok(focus.inside && !focus.body && focus.visible && !focus.disabled,'expiry should return focus to a usable visible options control: '+JSON.stringify(focus))
    assert.equal(await js('document.querySelector(".primary-button").textContent.includes("Generar QR para Android")'),true,'expired QR options should allow a fresh explicit invitation')
    assert.equal(await js('__qrViewportQA.counts().invites'),countBefore,'expiry must not silently generate a replacement invitation')
    console.log('PASS '+JSON.stringify({...item,viewport:initial.viewport,modules:moduleCount,moduleDevicePixels:initial.image.rect.width/(moduleCount+8)*item.dpr,qrRect:initial.image.rect,expiryFocus:focus}))
    w.destroy()
  }
  app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
`)

// The PNG itself is generated from opaque synthetic bytes, never a live invitation.
let seed = 17
const token = length => Array.from({ length }, () => { seed = (seed * 48271) % 2147483647; return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[seed % 62] }).join('')
const payload = `crow3:${token(2535)}`
const QRCode = require('qrcode')
const qrModuleCount = QRCode.create(payload, { errorCorrectionLevel: 'L' }).modules.size
assert.ok(qrModuleCount >= 133, `fixture should represent a dense QR, got ${qrModuleCount} modules`)
const cases = [
  { physicalWidth: 1366, physicalHeight: 768, dpr: 1.25 },
  { physicalWidth: 1920, physicalHeight: 1080, dpr: 1 },
  { physicalWidth: 1920, physicalHeight: 1080, dpr: 1.25 },
  { physicalWidth: 1920, physicalHeight: 1080, dpr: 1.5 },
]
process.env.CROW_QR_MODULES = String(qrModuleCount)
const childEnv = { ...process.env, CROW_QR_PORT: String(server.httpServer.address().port) }
delete childEnv.ELECTRON_RUN_AS_NODE
try {
  for (const item of cases) {
    const code = await new Promise((yes, no) => {
      const child = spawn(require('electron'), [`--force-device-scale-factor=${item.dpr}`, electronScript], { env: { ...childEnv, CROW_QR_CASES: JSON.stringify([item]) }, stdio: 'inherit', windowsHide: true })
      const timer = setTimeout(() => { child.kill(); no(new Error('QR viewport Electron QA timed out')) }, 120000)
      child.once('error', no)
      child.once('exit', code => { clearTimeout(timer); yes(code) })
    })
    if (code !== 0) throw new Error(`QR viewport Electron QA failed at ${item.physicalWidth}x${item.physicalHeight}@${item.dpr}`)
  }
  console.log(`Evidence saved under ${evidenceDir}`)
} finally {
  server.httpServer?.closeAllConnections()
  await server.close()
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('crow-qr-viewport-')) throw new Error('Unexpected cleanup path')
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
