// Run explicitly: node tests/terminal-clipboard-electron.mjs
// Real Electron keyboard/menu + real TerminalPane/xterm; only fictional IPC.
// No app build, production profile, system clipboard access or SSH.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const temp = await mkdtemp(join(tmpdir(), 'crow-clipboard-qa-'))
const baseline = process.argv.includes('--baseline')
const oldPane = baseline ? execFileSync('git', ['show', 'v0.1.21:src/renderer/src/TerminalPane.tsx'], { encoding: 'utf8' }) : ''
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [
  { name: 'clipboard-baseline', enforce: 'pre', transform: (_code, id) => baseline && id.replaceAll('\\', '/').endsWith('/src/renderer/src/TerminalPane.tsx') ? oldPane : undefined },
  react()
], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/clipboard-ui.html`
const main = join(temp, 'main.cjs')
await writeFile(main, `
const { app, BrowserWindow, Menu } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require(${JSON.stringify(require.resolve('typescript'))})
const helpers = {}
new Function('exports', ts.transpileModule(fs.readFileSync(${JSON.stringify(join(process.cwd(), 'src/main/clipboard-shortcuts.ts'))}, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(helpers)
app.setPath('userData', ${JSON.stringify(join(temp, 'profile'))})
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-timer-throttling')
const delay = ms => new Promise(r => setTimeout(r, ms))
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 600, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  let intercepted = 0
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [
    { label: 'Copy', accelerator: 'Ctrl+C', click: () => intercepted++ },
    { label: 'Paste', accelerator: 'Ctrl+V', click: () => intercepted++ }
  ] }]))
  await window.loadURL(${JSON.stringify(url)})
  const js = async code => {
    const value = await window.webContents.executeJavaScript('(async()=>{try{return await eval(' + JSON.stringify(code) + ')}catch(e){return {__qaError:String(e)}}})()')
    if(value?.__qaError)throw new Error(value.__qaError)
    return value
  }
  for(let i=0;i<100;i++){if(await js('Boolean(window.qa)'))break; await delay(100)}
  await js("qa.write('texto de prueba')")
  const shortcut = async (keyCode, modifiers = ['control']) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await delay(100)
  }
  window.webContents.on('before-input-event', (_event, input) => window.webContents.setIgnoreMenuShortcuts(helpers.ignoreClipboardMenuShortcut(input)))
  await js('qa.select(5)'); await shortcut('C')
  assert.equal((await js('qa.state()')).copied, 'texto'); assert.equal(intercepted, 0)
  console.log('PASS Ctrl+C selection (hidden-window keyboard; not a focused menu test)')
  await js('qa.reset(); qa.select(5)'); await js('qa.redraw()'); await shortcut('C')
  assert.equal((await js('qa.state()')).copied, 'texto')
  console.log('PASS Ctrl+C retained selection after redraw')
  await js('qa.reset()'); await shortcut('C')
  assert.deepEqual((await js('qa.state()')).input, ['\\x03'])
  console.log('PASS Ctrl+C without selection sends interrupt')
  await js('qa.reset(); qa.clipboard("mensaje pegado")'); await shortcut('V')
  assert.deepEqual((await js('qa.state()')).input, ['mensaje pegado']); assert.equal((await js('qa.state()')).reads, 1)
  console.log('PASS Ctrl+V pastes exactly once')
  await js('qa.reset(); qa.clipboard("shift paste")'); await shortcut('V', ['control', 'shift'])
  assert.deepEqual((await js('qa.state()')).input, ['shift paste'])
  await js('qa.reset()'); await shortcut('Insert', ['shift'])
  assert.deepEqual((await js('qa.state()')).input, ['shift paste'])
  console.log('PASS Ctrl+Shift+V and Shift+Insert')
  await js('qa.reset(); qa.select(5)'); await js('qa.redraw()')
  assert.equal(await js('qa.nativeCopy()'), 'texto')
  await js('qa.reset(); qa.nativePaste("uno\\\\ndos")')
  assert.deepEqual((await js('qa.state()')).input, ['uno\\rdos'])
  console.log('PASS native copy/paste, no duplicate xterm handlers')
  await js('qa.reset(); qa.write("\\x1b]52;c;" + btoa("seleccion Claude") + "\\x07")'); await shortcut('C')
  assert.equal((await js('qa.state()')).copied, 'seleccion Claude')
  console.log('PASS Ctrl+C agent OSC52 offered selection')
  await js('qa.reset(); qa.outside()'); await shortcut('C'); await shortcut('V')
  assert.deepEqual((await js('qa.state()')).outsideKeys, ['c', 'v']); assert.equal((await js('qa.state()')).reads, 0)
  console.log('PASS form field shortcuts not stolen by terminal')
  await js('qa.active(false)'); await delay(50); await js('qa.nativePaste("no debe enviarse")')
  assert.deepEqual((await js('qa.state()')).input, [])
  console.log('PASS inactive/disconnected terminal rejects paste')
  window.destroy(); app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.CROW_MCP_CONFIG
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [main], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron clipboard QA timed out')) }, 90_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  if (code !== 0) throw new Error('Electron clipboard QA failed')
} finally {
  await server.close()
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('crow-clipboard-qa-')) throw new Error('Unexpected QA cleanup path')
  await rm(temp, { recursive: true, force: true })
}
