// Real React startup flow, fictional SSH/IPC only. Never opens FreeLLMAPI.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const temp = await mkdtemp(join(tmpdir(), 'crow-startup-qa-'))
const server = await createServer({configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:0}})
await server.listen()
const main = join(temp,'main.cjs')
await writeFile(main, `
const {app,BrowserWindow}=require('electron'), assert=require('node:assert/strict')
app.setPath('userData',${JSON.stringify(join(temp,'profile'))});app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/notice-audio-ui.html?startup=1`)})
 const js=code=>w.webContents.executeJavaScript(code)
 for(let i=0;i<100;i++){if(await js('Boolean(document.querySelector("#passphrase-title"))'))break;await delay(100)}
 assert.equal(await js('Boolean(document.querySelector("#passphrase-title"))'),true)
 await delay(1000);assert.equal(await js('__audioQA.startupCalls()'),0)
 console.log('PASS no Free LLM check while first SSH key is locked')
 for(let i=0;i<2;i++){
   await js('document.querySelector("input[autocomplete=off]").focus()')
   w.webContents.insertText('fictional-phrase');await delay(50)
   await js('document.querySelector("dialog form").requestSubmit()');await delay(200)
   if(i===0){await delay(900);assert.equal(await js('__audioQA.startupCalls()'),0);assert.equal(await js('Boolean(document.querySelector("#passphrase-title"))'),true)}
 }
 await delay(1000);assert.equal(await js('__audioQA.startupCalls()'),1)
 assert.equal(await js('Boolean(document.querySelector("#passphrase-title"))'),false)
 assert.equal(await js('document.querySelector(".free-llm-banner").textContent.includes("QA API disponible")'),true)
 console.log('PASS check after both SSH phrases, not after only the first')
 await js('__audioQA.emitStatus("host","disconnected");__audioQA.emitStatus("host","connected")');await delay(1000)
 assert.equal(await js('__audioQA.startupCalls()'),1)
 console.log('PASS reconnect does not repeat automatic startup')
 await js('__audioQA.runtimeError()');await delay(50)
 assert.equal(await js('document.querySelector(".free-llm-banner").getAttribute("role")'), 'alert')
 await js('[...document.querySelectorAll(".free-llm-banner button")].find(b=>b.textContent.includes("Comprobar")).click()');await delay(100)
 assert.equal(await js('__audioQA.startupCalls()'),2)
 console.log('PASS visible warning with explicit retry without touching terminal state')
 w.destroy();app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
`)
try {
  execFileSync(process.execPath,['--check',main],{stdio:'pipe'})
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CROW_MCP_CONFIG
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(require('electron'),[main],{env,stdio:'inherit',windowsHide:true})
    const timer=setTimeout(()=>{child.kill();reject(new Error('Startup QA timed out'))},45000)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',code=>{clearTimeout(timer);resolve(code)})
  })
  if(code!==0)throw new Error('Electron startup QA failed')
} finally {
  server.httpServer?.closeAllConnections();await server.close()
  if(dirname(resolve(temp))!==resolve(tmpdir()) || !temp.includes('crow-startup-qa-'))throw new Error('Unexpected cleanup path')
  await rm(temp,{recursive:true,force:true})
}
