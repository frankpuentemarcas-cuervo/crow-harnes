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
    if (baseline && id.split(String.fromCharCode(92)).join('/').endsWith('/src/renderer/src/session-notices.ts')) return oldNotices
    if (!id.split(String.fromCharCode(92)).join('/').endsWith('/src/renderer/src/App.tsx')) return
    // Reproduce any IPC action returning a full Store snapshot ahead of the
    // classification event. This setter exists ONLY in the isolated QA page.
    return (baseline ? oldApp : code).replace('  const selectedProject =', '  ;(window as any).__audioQA.replaceState = setState\n  const selectedProject =')
  } }, react()
], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/notice-audio-ui.html`
const main = join(temp, 'main.cjs')
const preload = join(temp, 'preload.cjs')
await writeFile(preload, `
const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('__auditBridge', Object.fromEntries(['status','enable','list','detail','clear','export','sound'].map(name=>[name,(...args)=>ipcRenderer.invoke('qa:audit:'+name,...args)])))
`)
await writeFile(main, `
const {app,BrowserWindow,ipcMain,safeStorage}=require('electron')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const ts=require(${JSON.stringify(require.resolve('typescript'))})
const exportsStore={}
const exportsDiagnostics={}
new Function('exports',ts.transpileModule(fs.readFileSync(${JSON.stringify(join(process.cwd(), 'src/shared/alert-diagnostics.ts'))},'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exportsDiagnostics)
const storeRequire=id=>id==='../shared/alert-diagnostics.ts'?exportsDiagnostics:require(id)
new Function('require','exports',ts.transpileModule(fs.readFileSync(${JSON.stringify(join(process.cwd(), 'src/main/alert-audit-store.ts'))},'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(storeRequire,exportsStore)
app.setPath('userData',${JSON.stringify(join(temp, 'profile'))})
app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 assert.equal(safeStorage.isEncryptionAvailable(),true,'This Windows QA requires real secure encryption')
 const audit=new exportsStore.AlertAuditStore(app.getPath('userData'),safeStorage,Date.now,()=>['secret-test-key'])
 let exportsRequested=0
 const actions={status:()=>audit.status(),enable:enabled=>audit.setEnabled(enabled),list:()=>audit.list(),detail:id=>audit.detail(id),clear:()=>audit.clear(),export:()=>{exportsRequested++;return {canceled:true}},sound:(...args)=>audit.sound(...args)}
 for(const [name,action] of Object.entries(actions))ipcMain.handle('qa:audit:'+name,(_event,...args)=>action(...args))
 const w=new BrowserWindow({show:false,width:1400,height:900,webPreferences:{preload:${JSON.stringify(preload)},sandbox:true,contextIsolation:true,nodeIntegration:false}})
 await w.loadURL(${JSON.stringify(url)})
 const js=async code=>{
  const value=await w.webContents.executeJavaScript('(async()=>{try{return await eval('+JSON.stringify(code)+')}catch(error){return {__qaError:String(error)}}})()')
  if(value?.__qaError)throw new Error(value.__qaError+' while running '+code)
  return value
 }
 const openAudit=async()=>{
  // Exercise the current settings menu; keep the historical --baseline path.
  const legacy=await js('Boolean(document.querySelector(\\'button[title="Diagnóstico de alertas"]\\'))')
  if(!legacy){
   await js('document.querySelector(\\'button[aria-label="Configuración e integraciones"]\\').click()');await delay(50)
   await js('[...document.querySelectorAll(\\'.workspace-menu-content button\\')].find(button=>button.textContent.includes("Diagnóstico de alertas")).click()')
  }else await js('document.querySelector(\\'button[title="Diagnóstico de alertas"]\\').click()')
  await delay(100)
 }
 for(let i=0;i<100;i++){if(await js('Boolean(window.__audioQA?.replaceState && document.querySelector(\\'button[title="Notificaciones"]\\'))'))break;await delay(100)}
 await js('__audioQA.openNotices()');await delay(150)
 for(let i=0;i<100;i++){if(await js('__audioQA.ready()'))break;await delay(100)}
 assert.equal(await js('__audioQA.ready()'),true)
 await js('__audioQA.testSound()');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,1)
 console.log('PASS manual test resumes context and schedules custom sound')
 await js('__audioQA.reset()')
 if(!${baseline}){
 await openAudit()
 assert.equal(audit.status().enabled,false)
 await js('document.querySelector(\\'.audit-dialog input[type="checkbox"]\\').click()');await delay(100)
 assert.equal(audit.status().enabled,true)
 await js('document.querySelector(\\'.audit-dialog .dialog-heading button\\').click()');await delay(50)
 console.log('PASS diagnostics opt-in from real dialog with real Windows encryption')
 }else{audit.setEnabled(true)}
 const now=Date.now()
 const n={id:'a',hostId:'host',sessionId:'session',seq:1,kind:'turn-complete',at:new Date(now).toISOString(),read:false,requiresAttention:true}
 const pending={...n,requiresAttention:false,classification:{source:'pending',decision:'uncertain',detail:'QA'}}
 const auditRef=audit.begin('host',{id:n.id,sessionId:n.sessionId,at:n.at,message:'¿A o B? private-marker Bearer secret-test-key <img src=x onerror="window.__unsafe=true">'},'auto')
 audit.update(auditRef,{classification:{source:'pending',decision:'uncertain',detail:'QA'}})
 await js('__audioQA.emit('+JSON.stringify(pending)+')');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,0)
 await js('__audioQA.snapshot('+JSON.stringify([n])+')');await delay(100)
 audit.update(auditRef,{classification:{source:'ai',decision:'actionable',detail:'Petición.'},reasonCode:'choice',explanation:'Pide elegir.',reportedModel:'model-a',httpStatus:200,inferenceMs:50})
 assert.equal(await js('__audioQA.bells()'),1)
 await js('__audioQA.emit('+JSON.stringify(n)+')');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,1,'snapshot before IPC must not silence sound')
 await js('__audioQA.emit('+JSON.stringify(n)+')');await delay(50)
 assert.equal((await js('__audioQA.starts()')).length,1)
 console.log('PASS automatic alert sounds once despite earlier actionable snapshot; bell visible')
 const recorded=audit.detail(auditRef.id)
 assert.deepEqual(recorded.sound.map(item=>item.outcome),['pending','eligible','scheduled','duplicate'])
 const ciphertext=fs.readFileSync(${JSON.stringify(join(temp, 'profile', 'alert-audit'))}+'/'+auditRef.id)
 assert.equal(ciphertext.includes(Buffer.from('private-marker')),false)
 assert.equal(JSON.stringify(recorded).includes('secret-test-key'),false)
 assert.equal(audit.exportJSON().includes('private-marker'),true)
 await openAudit()
 await js('document.querySelector(\\'.audit-row\\').click()');await delay(100)
 assert.equal(await js('document.querySelector(\\'.audit-detail pre\\').textContent.includes("private-marker")'),true)
 assert.equal(await js('document.querySelector(\\'.audit-detail img\\')===null && !window.__unsafe'),true)
 assert.equal(await js('document.querySelector(\\'.audit-detail\\').textContent.includes("model-a")'),true)
 await js('[...document.querySelectorAll(\\'.audit-actions button\\')].find(b=>b.textContent.includes("Exportar")).click()');await delay(50)
 assert.equal(exportsRequested,0,'Export must wait for explicit human confirmation')
 await js('document.querySelector(\\'.confirm-dialog [data-cancel]\\').click()');await delay(50)
 assert.equal(exportsRequested,0)
 await js('document.querySelector(\\'.audit-dialog .dialog-heading button\\').click()');await delay(50)
 console.log('PASS encrypted trace correlated to sound, safe text rendering and export cancellation')
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
 await w.setSize(375,740)
 await openAudit()
 assert.equal(await js('document.querySelector(\\'.audit-dialog\\').getBoundingClientRect().right<=window.innerWidth'),true)
 await js('[...document.querySelectorAll(\\'.audit-actions button\\')].find(b=>b.textContent.includes("Borrar")).click()');await delay(50)
 await js('document.querySelector(\\'.confirm-dialog .danger-button\\').click()');await delay(100)
 assert.equal(audit.list().length,0)
 assert.equal(await js('document.querySelectorAll(\\'.audit-row\\').length'),0)
 console.log('PASS narrow dialog and explicit clear update UI without resurrecting records')
 w.destroy();app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
`)
try {
  // Catch generated-script syntax errors before Electron can open an error
  // dialog and stall cleanup. --check parses only; it executes no app code.
  execFileSync(process.execPath, ['--check', main], { stdio: 'pipe' })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.CROW_MCP_CONFIG
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [main], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Notice audio QA timed out')) }, 90000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  if (code !== 0) throw new Error('Electron notice audio QA failed')
} finally {
  server.httpServer?.closeAllConnections()
  await server.close()
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('crow-notice-audio-qa-')) throw new Error('Unexpected QA cleanup path')
  await rm(temp, { recursive: true, force: true })
}
