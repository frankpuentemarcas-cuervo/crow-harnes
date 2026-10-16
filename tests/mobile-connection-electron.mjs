// Mount the actual MobileApp with an isolated transport, not source regex assertions.
// Vite serves test transforms only: no product build, installed profile or network credentials.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url), temp = await mkdtemp(join(tmpdir(), 'crow-connection-qa-'))
const mock = resolve('tests/fixtures/mobile-connection.mock.tsx')
const server = await createServer({ configFile: false, root: process.cwd(), resolve: { dedupe: ['react', 'react-dom'] }, plugins: [{ name: 'isolated-connection-native', enforce: 'pre', resolveId(source, importer) { if (importer?.replaceAll('\\', '/').includes('/packages/android-companion/src/') && ['@capacitor/core', '@capacitor/app', '@capacitor/barcode-scanner', './TerminalView', './ChatView'].includes(source)) return mock } }, react()], server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/android/**', '**/dist/**'] } } })
await server.listen()
const script = join(temp, 'main.cjs')
await writeFile(script, `
const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict')
app.setPath('userData', ${JSON.stringify(join(temp, 'profile'))}); app.disableHardwareAcceleration()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  console.log('MobileApp QA: ready')
  const w = new BrowserWindow({ show:false, width:390, height:844, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false } })
  w.webContents.on('console-message', event => { if(event.level==='error') console.error('Renderer:', event.message) })
  const js = code => w.webContents.executeJavaScript(code)
  const wait = async (expression, timeout=4000) => { for (let i=0;i<timeout/25;i++) { if (await js(expression)) return; await delay(25) } throw new Error('Timed out: '+expression) }
  await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mobile-connection-ui.html`)})
  console.log('MobileApp QA: loaded')
  await wait('document.querySelector(".session") && !document.querySelector(".session").disabled')
  await delay(250)
  assert.equal(await js('__connectionQA.counts.windows'),1,'bootstrap metadata must not retrigger its own effect')
  assert.equal(await js('__connectionQA.counts.sessions'),1)
  await js('document.querySelector(".session").click()')
  await wait('document.querySelector(".qa-terminal")?.dataset.profile === "factory"')
  await js('__connectionQA.back()'); await wait('Boolean(document.querySelector(".session"))')
  console.log('PASS actual MobileApp settles and existing/new terminals remain enabled through their host anchor')
  await js('{const select=document.querySelector("#active-gateway");select.value="factory";select.dispatchEvent(new Event("change",{bubbles:true}))}')
  await wait('document.querySelector(".connection-connected") && document.querySelector(".connection strong")?.textContent === "FACTORY"')
  await js('__connectionQA.hold("factory");document.querySelector(".header-refresh").click();__connectionQA.foreground();__connectionQA.foreground()')
  await delay(80)
  assert.equal(await js('__connectionQA.counts.factory'),2,'foreground/manual probes must coalesce')
  assert.equal(await js('document.querySelector(".session").disabled'),false,'background checking must not lock an authorized terminal')
  await wait('__connectionQA.counts.cancelled >= 1',18000)
  await wait('document.querySelector(".connection-disconnected") && !document.querySelector(".header-refresh").disabled')
  assert.equal(await js('document.querySelector(".error").textContent.includes("15 segundos")'),true)
  await js('__connectionQA.hold("");document.querySelector(".connection-retry").click()')
  await wait('document.querySelector(".connection-connected") && !document.querySelector(".session").disabled')
  assert.equal(await js('__connectionQA.counts.writes'),0,'connection recovery cannot replay a command')
  console.log('PASS bounded wait cancels the native read, exits checking and recovers without QR reset or command retry')
  await js('{__connectionQA.hold("windows");const select=document.querySelector("#active-gateway");select.value="windows";select.dispatchEvent(new Event("change",{bubbles:true}))}')
  await delay(30)
  await js('{const select=document.querySelector("#active-gateway");select.value="factory";select.dispatchEvent(new Event("change",{bubbles:true}));__connectionQA.release()}')
  await wait('document.querySelector(".connection-connected") && document.querySelector(".connection strong")?.textContent === "FACTORY"')
  await delay(80)
  assert.equal(await js('document.querySelector("#active-gateway").value'),'factory')
  await new Promise(yes=>{w.webContents.once('did-finish-load',yes);w.reload()})
  await wait('document.querySelector(".connection-connected") && document.querySelector("#active-gateway")?.value === "factory"')
  assert.equal(await js('__connectionQA.counts.windows'),0,'a saved direct host must not wait for Windows at startup')
  await js('{__connectionQA.fail("Sin conexión con Crow");const select=document.querySelector("#active-gateway");select.value="windows";select.dispatchEvent(new Event("change",{bubbles:true}))}')
  await wait('document.querySelector(".connection-connected") && document.querySelector("#active-gateway")?.value === "factory"')
  console.log('PASS selected direct host survives restart; offline Windows falls back without blocking FACTORY')
  await js('{__connectionQA.hold("");__connectionQA.fail("Crow rechazó la autenticación del dispositivo");const select=document.querySelector("#active-gateway");select.value="windows";select.dispatchEvent(new Event("change",{bubbles:true}))}')
  await wait('Boolean(document.querySelector(".connection-revoked"))')
  assert.equal(await js('document.querySelector("#active-gateway").value'),'windows','auth failures cannot silently switch identities')
  console.log('PASS late results cannot overwrite another host and authentication failures stay explicit')
  w.destroy(); app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((yes, no) => { const child = spawn(require('electron'), [script], { env, stdio:'inherit', windowsHide:true }); const timer = setTimeout(() => { child.kill(); no(new Error('Mobile connection UI QA timeout')) },45000); child.once('error',no); child.once('exit',code=>{clearTimeout(timer);yes(code)}) })
  if (code !== 0) throw new Error('Mobile connection UI regression failed')
} finally {
  server.httpServer?.closeAllConnections(); await server.close()
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('crow-connection-qa-')) throw new Error('Unexpected cleanup path')
  await rm(temp, { recursive:true, force:true, maxRetries:10, retryDelay:300 })
}
