// Actual React/Electron controls; fictional IPC, no production profiles or builds.
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),temp=await mkdtemp(join(tmpdir(),'crow-erp-assignment-qa-'))
const evidenceDir=resolve(process.env.CROW_ERP_EVIDENCE_DIR||join(tmpdir(),'crow-erp-terminal-assignment-evidence'))
await mkdir(evidenceDir,{recursive:true})
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:join(temp,'node_modules','.vite'),plugins:[react()],optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','lucide-react']},server:{host:'127.0.0.1',port:0}});await server.listen()
const main=join(temp,'main.cjs')
await writeFile(main,`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(temp,'profile'))});app.disableHardwareAcceleration()
const delay=ms=>new Promise(r=>setTimeout(r,ms))
app.whenReady().then(async()=>{
const w=new BrowserWindow({show:false,width:1400,height:950,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/erp-terminal-assignment-ui.html`)})
const js=s=>w.webContents.executeJavaScript(s),click=label=>js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()'),select=(label,value)=>js('(()=>{const e=[...document.querySelectorAll("label")].find(l=>l.firstChild?.textContent==='+JSON.stringify(label)+').querySelector("select");e.value='+JSON.stringify(label==='Terminal existente'?'h:'+value:value)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()')
for(let i=0;i<100;i++){if(await js('document.querySelectorAll(".erp-task").length===1'))break;await delay(50)}
assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].stage'),'review')
await click('Cambiar terminal').catch(()=>click('Asignar terminal'));await delay(100);await select('Terminal existente','one');await delay(100)
let state=await js('__assignmentQA.state()');assert.equal(state.links,1);assert.equal(state.sends,0);assert.equal(state.snapshot.tasks[0].jobId,undefined);assert.equal(state.snapshot.tasks[0].sessionName,'Custom Claude');assert.equal(state.snapshot.tasks[0].stage,'ready')
console.log('PASS fresh unassigned task link-only persists custom name without input/job/working')
await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');w.webContents.invalidate();await delay(250);require('node:fs').writeFileSync(${JSON.stringify(join(evidenceDir,'erp-terminal-assignment-populated.png'))},(await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())
await js('__assignmentQA.failView(true)');await click('Ver en terminal');await delay(100);assert.equal(await js('__assignmentQA.state().closed'),0);assert.ok(await js('document.body.textContent.includes("Fictional terminal unavailable")'));assert.equal(await js('[...document.querySelectorAll("label")].find(l=>l.firstChild?.textContent==="Terminal existente").querySelector("select").value'),'h:one')
await js('__assignmentQA.failView(false)');await click('Ver en terminal');await delay(100);assert.deepEqual((await js('__assignmentQA.state()')).views,[['p','one']]);assert.equal(await js('__assignmentQA.state().closed'),1)
console.log('PASS view opens exact project/session; failure retains modal and terminal selection')
await click('Cambiar terminal').catch(()=>click('Asignar terminal'));await delay(80);await js('__assignmentQA.failLink(true)');await select('Terminal existente','two');await delay(100);assert.equal(await js('[...document.querySelectorAll("label")].find(l=>l.firstChild?.textContent==="Terminal existente").querySelector("select").value'),'h:two');assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].sessionId'),'one')
await js('__assignmentQA.failLink(false)');await click('Guardar vínculo');await delay(100);assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].sessionId'),'two');assert.equal(await js('__assignmentQA.state().sends'),0)
await js('__assignmentQA.reload()');await delay(100);assert.ok(await js('document.body.textContent.includes("Custom Codex")'))
console.log('PASS changing terminal never sends/closes; failed save preserves selection; refreshed link survives')
await click('Cambiar terminal').catch(()=>click('Asignar terminal'));await delay(80);await select('Terminal existente','shell');await delay(80);assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Asignar y enviar detalle").disabled'),true)
await select('Terminal existente','two');await delay(80);await click('Asignar y enviar detalle');await delay(100);assert.equal(await js('__assignmentQA.state().sends'),0);assert.ok(await js('document.querySelector(".erp-prompt").textContent.includes("Exact fictional detail")'));assert.ok(await js('document.body.textContent.includes("terminal existente Custom Codex")'))
await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Confirmar envío a esta terminal").click()');await delay(100);state=await js('__assignmentQA.state()');assert.equal(state.sends,1);assert.equal(state.snapshot.tasks[0].stage,'human-review');assert.equal(state.snapshot.tasks[0].submissionStatus,'written');assert.ok(await js('document.body.textContent.includes("Entrega anterior: Custom Codex")'))
console.log('PASS existing Claude/Codex detail sends once only after exact preview confirmation; written is not working')
await click('Consultar aceptación (sin reenviar)');await delay(100);assert.equal(await js('__assignmentQA.state().sends'),1);assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].stage'),'running')
console.log('PASS read-only hook acceptance reconciliation marks running without resend')
await js('__assignmentQA.fresh()');await delay(100);assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].stage'),'review');await click('Cambiar terminal').catch(()=>click('Asignar terminal'));await delay(80);await select('Terminal existente','one');await delay(80);await click('Asignar y enviar detalle');await delay(80);assert.equal(await js('__assignmentQA.state().sends'),1);await click('Confirmar envío a esta terminal');await delay(80);assert.equal(await js('__assignmentQA.state().sends'),2);assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].sessionId'),'one');assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].stage'),'human-review')
console.log('PASS fresh review-stage direct assign+send requires no separate link save')
await js('__assignmentQA.holdTerminals()');await click('Cambiar terminal');await delay(80);await js('__assignmentQA.reload();__assignmentQA.releaseTerminals()');await delay(120);assert.equal(await js('[...document.querySelectorAll("label")].some(l=>l.firstChild?.textContent==="Terminal existente")'),false)
console.log('PASS access change discards a late terminal catalogue instead of restoring stale identity choices')
await js('__assignmentQA.cached()');await delay(100);assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Asignar terminal").disabled'),false)
await click('Consultar DocType Task · Open');await delay(80);await click('Asignar terminal');await delay(80);assert.ok(await js('document.body.textContent.includes("Readable host")'));await select('Terminal existente','two');await delay(80);assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].projectId'),'p2');assert.equal(await js('__assignmentQA.state().snapshot.tasks[0].stale'),true);assert.equal(await js('__assignmentQA.state().sends'),2);await js('__assignmentQA.finishRefresh()');await delay(120);assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Cambiar terminal").disabled'),false);assert.ok(await js('document.body.textContent.includes("Fictional ERP unavailable")'))
console.log('PASS stale projectless cache auto-links during deferred/failing ERP refresh without sending or clearing staleness')
await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');w.webContents.invalidate();await delay(150);require('node:fs').writeFileSync(${JSON.stringify(join(evidenceDir,'erp-terminal-assignment-stale-autolink.png'))},(await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())
await js('(()=>{const input=document.querySelector("input[type=url]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"https://edited.example.org");input.dispatchEvent(new Event("input",{bubbles:true}))})()');await js('__assignmentQA.erpChanged()');await delay(80);assert.equal(await js('document.querySelector("input[type=url]").value'),'https://edited.example.org')
console.log('PASS background ERP update preserves unsaved connection edits')
w.destroy();app.exit(0)
}).catch(e=>{console.error(e);app.exit(1)})
`)
try{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CROW_MCP_CONFIG;const code=await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[main],{env,stdio:'inherit',windowsHide:true}),timer=setTimeout(()=>{child.kill();reject(new Error('Assignment QA timed out'))},45000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);resolve(code)})});if(code!==0)throw new Error('Assignment Electron QA failed')}
finally{server.httpServer?.closeAllConnections();await server.close();if(dirname(resolve(temp))!==resolve(tmpdir())||!temp.includes('crow-erp-assignment-qa-'))throw new Error('Unexpected cleanup path');await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
