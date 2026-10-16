// Real ChatView + styles and isolated fake transport. No installed profile, SSH,
// product build or credentials. Exercises StrictMode and native-sized viewports.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url), temp = await mkdtemp(join(tmpdir(), 'crow-chat-qa-'))
const mock = resolve('tests/fixtures/chat-native.mock.ts')
const server = await createServer({ configFile: false, root: process.cwd(), resolve: { dedupe: ['react', 'react-dom'] }, plugins: [{ name: 'isolated-chat-native', enforce: 'pre', resolveId(source, importer) { if (importer?.replaceAll('\\', '/').endsWith('/ChatView.tsx') && ['./native', '@capacitor/app', '@capacitor/clipboard'].includes(source)) return mock } }, react()], server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/android/**', '**/dist/**'] } } })
await server.listen()
await mkdir('dist/chat-fluidity-qa', { recursive: true })
const script = join(temp, 'main.cjs')
await writeFile(script, `
const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict'), fs = require('node:fs')
app.setPath('userData', ${JSON.stringify(join(temp, 'profile'))}); app.disableHardwareAcceleration()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show:false, useContentSize:true, width:390, height:844, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false } })
  w.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message) })
  const js = code => w.webContents.executeJavaScript(code)
  const wait = async expression => { for (let i=0;i<120;i++) { if (await js(expression)) return; await delay(25) } throw new Error('Timed out: '+expression) }
  const bottom = () => js('(()=>{const e=document.querySelector(".chat-transcript");return e.scrollHeight-e.clientHeight-e.scrollTop<3})()')
  await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/chat-fluidity-ui.html`)})
  await wait('document.querySelector(".chat-transcript")?.textContent.includes("LATEST ANSWER") && document.querySelector(".chat-status")?.textContent === "En línea"')
  await delay(80); assert.equal(await bottom(),true)
  assert.equal(await js('document.querySelector(".chat-identity strong").textContent'), 'Named desktop console')
  assert.equal(await js('document.querySelector(".chat-heading").getBoundingClientRect().height<70'),true)
  assert.equal(await js('document.querySelector("#chat-draft").disabled'),false)
  console.log('PASS latest response loaded at bottom and unknown-state desktop terminal remains editable')
  await js('document.querySelector("#chat-draft").focus()'); w.webContents.insertText('Hello from chat'); await delay(30)
  await js('document.querySelector(".chat-compose").requestSubmit()')
  await wait('document.querySelector(".outgoing-sending")?.textContent.includes("Hello from chat")')
  assert.equal(await js('__chatQA.sends()'),1)
  await js('__chatQA.ack()'); await wait('Boolean(document.querySelector(".outgoing-delivered"))')
  assert.equal(await js('document.querySelector("#chat-draft").disabled'),false)
  assert.equal(await js('document.querySelector(".chat-activity").textContent.includes("Recibido por la terminal")'),true)
  await js('__chatQA.accepted()'); await wait('document.querySelector(".chat-activity")?.textContent.includes("está trabajando")')
  await js('__chatQA.complete("LIVE AGENT RESPONSE")')
  await wait('document.querySelector(".chat-transcript").textContent.includes("LIVE AGENT RESPONSE")')
  await wait('document.querySelector(".chat-inline-notice")?.textContent === "Respuesta recibida."')
  assert.equal(await bottom(),true); assert.equal(await js('__chatQA.sends()'),1)
  console.log('PASS pending, PTY acknowledgement and agent activity are distinct; response arrives via live state without poll delay')
  await js('__chatQA.hold();document.querySelector(".chat-toolbar button").click()'); await delay(40)
  await js('__chatQA.complete("RESPONSE WHILE READING");__chatQA.release()')
  await wait('document.querySelector(".chat-transcript").textContent.includes("RESPONSE WHILE READING")')
  console.log('PASS a response arriving during a read is not lost')
  await js('document.querySelector(".chat-transcript").scrollTop=0'); await delay(50)
  await js('__chatQA.complete("UNREAD RESPONSE")'); await wait('Boolean(document.querySelector(".chat-latest"))')
  assert.equal(await bottom(),false)
  await js('document.querySelector(".chat-latest").click()'); await wait('document.querySelector(".chat-transcript").textContent.includes("UNREAD RESPONSE")'); await delay(40)
  assert.equal(await bottom(),true)
  await js('__chatQA.active(false)'); await delay(30); await js('__chatQA.complete("LATEST AFTER RETURN");__chatQA.active(true)')
  await wait('document.querySelector(".chat-transcript").textContent.includes("LATEST AFTER RETURN")'); await delay(50)
  assert.equal(await bottom(),true)
  console.log('PASS reading position is preserved; reopening Chat fetches the latest response')
  for (const [width,height] of [[390,844],[360,740],[360,380]]) {
    w.setContentSize(width,height); await delay(80)
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true)
    assert.equal(await js('(()=>{const r=document.querySelector(".chat-compose").getBoundingClientRect();return r.bottom<=innerHeight+1 && r.top>=0})()'),true)
    assert.equal(await js('document.querySelector(".chat-transcript").clientHeight>40'),true)
  }
  w.setContentSize(390,844); await delay(80)
  fs.writeFileSync(${JSON.stringify(resolve('dist/chat-fluidity-qa/chat-390x844.png'))}, (await w.webContents.capturePage()).toPNG())
  console.log('PASS composer and transcript fit mobile and keyboard-sized viewports')
  w.destroy(); app.exit(0)
}).catch(error=>{ console.error(error); app.exit(1) })
`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((yes, no) => { const child = spawn(require('electron'), [script], { env, stdio: 'inherit', windowsHide: true }); const timer = setTimeout(() => { child.kill(); no(new Error('Chat UI QA timeout')) }, 45000); child.once('error', no); child.once('exit', code => { clearTimeout(timer); yes(code) }) })
  if (code !== 0) throw new Error('Chat UI regression failed')
} finally {
  server.httpServer?.closeAllConnections(); await server.close()
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('crow-chat-qa-')) throw new Error('Unexpected cleanup path')
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
