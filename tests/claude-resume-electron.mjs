// Real App/React/CSS, fictional scoped IPC; no build, real Claude, SSH or user profile.
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),temp=await mkdtemp(join(tmpdir(),'crow-resume-qa-')),evidence=join(tmpdir(),'crow-resume-evidence')
await mkdir(evidence,{recursive:true})
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:join(temp,'node_modules','.vite'),plugins:[react()],optimizeDeps:{include:['react','react-dom/client','lucide-react','react-markdown','remark-gfm','@xterm/xterm','@xterm/addon-fit','@xterm/addon-serialize','@monaco-editor/react']},server:{host:'127.0.0.1',port:0}});await server.listen()
const main=join(temp,'main.cjs')
await writeFile(main,`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(temp,'profile'))});app.disableHardwareAcceleration()
const delay=ms=>new Promise(r=>setTimeout(r,ms));app.whenReady().then(async()=>{
const w=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}}),js=s=>w.webContents.executeJavaScript(s),wait=async s=>{for(let i=0;i<120;i++){if(await js(s))return;await delay(50)}throw new Error('Timed out '+s)},click=async label=>{const point=await js('(()=>{const e=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+');if(!e)throw Error("Missing button");const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await delay(20)}
w.webContents.on('console-message',event=>{if(event.level==='error')console.error('Renderer:',event.message)})
await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/claude-resume-ui.html`)})
await wait('!!document.querySelector(".claude-history")');assert.equal(await js('__resumeQA.state().posts'),0)
await click('Conversaciones Claude');await wait('document.body.textContent.includes("Conversación Diseño QA")');assert.equal(await js('__resumeQA.state().posts'),0)
await js('__resumeQA.hold();(()=>{const button=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Reanudar");button.click();button.click()})()');await wait('__resumeQA.state().posts===1');assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Reanudando")).disabled'),true)
await js('__resumeQA.release()');await wait('document.querySelector(".tab-select")?.textContent.includes("Conversación Diseño QA")');assert.equal(await js('__resumeQA.state().saved.sessionNames["h:"+"b".repeat(32)]'),'Conversación Diseño QA');assert.ok(await js('document.body.textContent.includes("Esperando confirmación de Claude")'));assert.equal(await js('__resumeQA.state().posts'),1)
console.log('PASS explicit exact history resume opens a new named tab; double click launches once; pending is not ready')
await js('__resumeQA.confirm()');await wait('!document.body.textContent.includes("Esperando confirmación de Claude")');assert.equal(await js('__resumeQA.state().posts'),1)
await click('Ver terminal');assert.equal(await js('document.querySelectorAll(".tab-select").length'),1);assert.equal(await js('__resumeQA.state().posts'),1)
console.log('PASS native handshake GET confirms readiness; active history focuses existing tab without new POST')
w.setSize(960,680);await delay(250);assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);const layout=await js('({width:innerWidth,height:innerHeight,buttons:[...document.querySelectorAll(".claude-history-row button")].map(button=>{const r=button.getBoundingClientRect(),s=getComputedStyle(button);return {text:button.textContent,label:button.getAttribute("aria-label"),x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,display:s.display,visibility:s.visibility}})})');assert.equal(layout.buttons.length,2);assert.equal(layout.buttons.every(button=>button.width>0&&button.height>0&&button.right<=layout.width&&button.x>=0&&button.display!=='none'&&button.visibility==='visible'),true);w.webContents.invalidate();await delay(250);const png=(await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG();require('node:fs').writeFileSync(${JSON.stringify(join(evidence,'claude-history-960.png'))},png);require('node:fs').writeFileSync(${JSON.stringify(join(evidence,'claude-history-layout.json'))},JSON.stringify(layout,null,2))
await js('__resumeQA.offline()');await wait('document.body.textContent.includes("Conectá el host")');assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Ver terminal")?.disabled??true'),true)
await js('__resumeQA.fail("Actualizá crowd para reanudar conversaciones.");__resumeQA.online()');await wait('document.body.textContent.includes("Actualizá crowd para reanudar conversaciones")');assert.equal(await js('__resumeQA.state().posts'),1)
console.log('PASS narrow layout does not overflow; disconnected and unsupported host show actionable state, never fallback launch')
w.destroy();app.exit(0)}).catch(e=>{console.error(e);app.exit(1)})
`)
try{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const code=await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[main],{env,stdio:'inherit',windowsHide:true}),timer=setTimeout(()=>{child.kill();reject(new Error('Resume UI QA timed out'))},45000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);resolve(code)})});if(code!==0)throw new Error('Resume Electron QA failed')}
finally{server.httpServer?.closeAllConnections();await server.close();if(dirname(resolve(temp))!==resolve(tmpdir())||!temp.includes('crow-resume-qa-'))throw new Error('Unexpected cleanup path');await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
