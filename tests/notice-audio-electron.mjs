// node tests/notice-audio-electron.mjs [--baseline]
// Real App + mocked IPC/audio; no build, physical sound, production state or SSH.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const baseline = process.argv.includes('--baseline')
const oldApp = baseline ? execFileSync('git', ['show', 'v0.1.22:src/renderer/src/App.tsx'], { encoding: 'utf8' }) : ''
const oldNotices = baseline ? execFileSync('git', ['show', 'v0.1.22:src/renderer/src/session-notices.ts'], { encoding: 'utf8' }) : ''
const temp = await mkdtemp(join(tmpdir(), 'crow-notice-audio-qa-'))
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [
  { name: 'audio-snapshot-seam', enforce: 'pre', transform(code, id) {
    if (baseline && id.replaceAll('\\', '/').endsWith('/src/renderer/src/session-notices.ts')) return oldNotices
    if (!id.replaceAll('\\', '/').endsWith('/src/renderer/src/App.tsx')) return
    // Reproduce any IPC action returning a full Store snapshot ahead of the
    // classification event. This setter exists ONLY in the isolated QA page.
    return (baseline ? oldApp : code).replace('  const selectedProject =', '  ;(window as any).__audioQA.replaceState = setState\n  const selectedProject =')
  } }, react()
], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/notice-audio-ui.html`
const main = join(temp, 'main.cjs')
await writeFile(main, `
const {app,BrowserWindow}=require('electron')
const assert=require('node:assert/strict')
app.setPath('userData',${JSON.stringify(join(temp, 'profile'))})
app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1400,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 await w.loadURL(${JSON.stringify(url)})
 const js=code=>w.webContents.executeJavaScript(code)
 for(let i=0;i<100;i++){if(await js('Boolean(window.__audioQA?.replaceState)'))break;await delay(100)}
 await js('__audioQA.openNotices()');await delay(150)
 for(let i=0;i<100;i++){if(await js('__audioQA.ready()'))break;await delay(100)}
 assert.equal(await js('__audioQA.ready()'),true)
 await js('__audioQA.testSound()');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,1)
 console.log('PASS manual test resumes context and schedules custom sound')
 await js('__audioQA.reset()')
 const now=Date.now()
 const n={id:'a',hostId:'host',sessionId:'session',seq:1,kind:'turn-complete',at:new Date(now).toISOString(),read:false,requiresAttention:true}
 const pending={...n,requiresAttention:false,classification:{source:'pending',decision:'uncertain',detail:'QA'}}
 await js('__audioQA.emit('+JSON.stringify(pending)+')');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,0)
 await js('__audioQA.snapshot('+JSON.stringify([n])+')');await delay(100)
 assert.equal(await js('__audioQA.bells()'),1)
 await js('__audioQA.emit('+JSON.stringify(n)+')');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,1,'snapshot before IPC must not silence sound')
 await js('__audioQA.emit('+JSON.stringify(n)+')');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,1)
 console.log('PASS automatic alert sounds once despite earlier actionable snapshot; bell visible')
 await js('__audioQA.reset()')
 const late={...n,id:'late',seq:2,at:new Date(Date.now()-110000).toISOString()}
 await js('__audioQA.emit('+JSON.stringify({...pending,...late,requiresAttention:false})+')')
 // Advance only renderer Date.now, without waiting two real minutes.
 await js('window.__realNow=Date.now;Date.now=()=>window.__realNow()+15000;void 0')
 await js('__audioQA.emit('+JSON.stringify(late)+')');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,1,'AI delay must not silence a fresh pending event')
 await js('Date.now=window.__realNow;__audioQA.reset()')
 console.log('PASS delayed AI result schedules custom sound in hidden window')
 for(const patch of [{id:'old',at:new Date(Date.now()-600000).toISOString()},{id:'info',requiresAttention:false},{id:'read',read:true}])await js('__audioQA.emit('+JSON.stringify({...n,...patch})+')')
 await delay(50);assert.equal((await js('__audioQA.starts()')).length,0)
 console.log('PASS old, informational and reviewed events remain silent')
 w.destroy();app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
`)
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.CROW_MCP_CONFIG
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [main], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Notice audio QA timed out')) }, 90000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  if (code !== 0) throw new Error('Electron notice audio QA failed')
} finally {
  await server.close()
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('crow-notice-audio-qa-')) throw new Error('Unexpected QA cleanup path')
  await rm(temp, { recursive: true, force: true })
}
