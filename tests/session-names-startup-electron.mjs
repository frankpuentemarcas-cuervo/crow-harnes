// Real App and CSS, fictional scoped IPC. No installed app profile, SSH or build.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url), temp=await mkdtemp(join(tmpdir(),'crow-names-ui-qa-'))
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:0}})
await server.listen()
const main=join(temp,'main.cjs')
await writeFile(main,`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict')
app.setPath('userData',${JSON.stringify(join(temp,'profile'))});app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
 w.webContents.on('console-message',event=>{if(event.level==='error')console.error('Renderer:',event.message)})
 const url=${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/session-names-startup-ui.html`)}
 const js=code=>w.webContents.executeJavaScript(code)
 const wait=async expression=>{for(let i=0;i<100;i++){if(await js(expression))return;await delay(50)}throw new Error('Timed out: '+expression)}
 const names=()=>js('[...document.querySelectorAll(".session-name")].map(x=>x.textContent)')
 await w.loadURL(url);await wait('Boolean(document.querySelector(".host-name"))');await delay(100)
 assert.deepEqual(await names(),[]);assert.equal(await js('__namesQA.stored()'),'Desarrollador QA')
 console.log('PASS disconnected startup hides names without deleting saved aliases')
 await js('document.querySelector("button[title=Conectar]").click()')
 await wait('document.querySelector(".session-name")?.textContent==="Desarrollador QA"')
 assert.equal(await js('document.body.textContent.includes("PRIVATE FOREIGN ALIAS")'),false)
 console.log('PASS reconnect restores permitted aliases without exposing foreign terminal names')
 await w.loadURL(url);await wait('Boolean(document.querySelector(".host-name"))');await delay(100)
 assert.deepEqual(await names(),[])
 await js('document.querySelector("button[title=Conectar]").click()')
 await wait('document.querySelector(".session-name")?.textContent==="Desarrollador QA"')
 console.log('PASS reopening App reconnects and restores persisted names again')
 const before=await js('__namesQA.reads()')
 await js('__namesQA.hold();__namesQA.status("connected")')
 await wait('__namesQA.reads()>'+before)
 await js('document.querySelector(".session-rename").click()');await wait('Boolean(document.querySelector("dialog input"))')
 await js('document.querySelector("dialog input").select()');w.webContents.insertText('QA actualizado');await delay(50)
 await js('document.querySelector("dialog form").requestSubmit()')
 await wait('document.querySelector(".session-name")?.textContent==="QA actualizado"')
 await js('__namesQA.release()');await delay(150)
 assert.deepEqual(await names(),['QA actualizado'])
 console.log('PASS late startup metadata cannot overwrite a newer rename')
 const reads=await js('__namesQA.reads()')
 await js('__namesQA.hold();__namesQA.status("connected")');await wait('__namesQA.reads()>'+reads)
 await js('__namesQA.identity()');await delay(100);await js('__namesQA.release()');await delay(150)
 assert.deepEqual(await names(),['Claude Code'])
 console.log('PASS access change invalidates a late metadata response from the previous identity')
 await js('__namesQA.status("disconnected");__namesQA.fail();__namesQA.status("connected")');await delay(200)
 assert.deepEqual(await names(),['Claude Code'])
 assert.equal(await js('document.body.textContent.includes("PRIVATE FOREIGN ALIAS")'),false)
 console.log('PASS metadata failure stays permission-safe and does not restore hidden aliases')
 w.destroy();app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
`)
try {
 execFileSync(process.execPath,['--check',main],{stdio:'pipe'})
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CROW_MCP_CONFIG
 const code=await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[main],{env,stdio:'inherit',windowsHide:true});const timer=setTimeout(()=>{child.kill();reject(new Error('Names UI QA timed out'))},45000);child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',code=>{clearTimeout(timer);resolve(code)})})
 if(code!==0)throw new Error('Electron names startup QA failed')
} finally {
 server.httpServer?.closeAllConnections();await server.close()
 if(dirname(resolve(temp))!==resolve(tmpdir())||!temp.includes('crow-names-ui-qa-'))throw new Error('Unexpected cleanup path')
 await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:300})
}
