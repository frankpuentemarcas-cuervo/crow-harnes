// Actual React/Modal, fictional ERP IPC only. No real account, SSH, API or build.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const temp = await mkdtemp(join(tmpdir(), 'crow-erp-ui-qa-'))
const server = await createServer({ configFile:false, root:process.cwd(), plugins:[react()], server:{host:'127.0.0.1',port:0} })
await server.listen()
const main = join(temp, 'main.cjs')
await writeFile(main, `
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict')
app.setPath('userData',${JSON.stringify(join(temp,'profile'))});app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/erp-kanban-pagination-ui.html`)})
 const js=code=>w.webContents.executeJavaScript(code)
 const click=label=>js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes('+JSON.stringify(label)+')).click()')
 for(let i=0;i<100;i++){if(await js('Boolean(document.querySelector("#erp-title"))'))break;await delay(100)}
 assert.equal(await js('Boolean(document.querySelector("#erp-title"))'),true);await delay(100)
 await click('Probar conexión');await delay(50)
 assert.equal(await js('document.body.textContent.includes("Procesando")'),true)
 assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Probar conexión")).disabled'),true)
 await click('Probar conexión');assert.deepEqual(await js('__erpQA.counts()'),{checkCount:1,syncCount:0})
 console.log('PASS busy connection check blocks duplicate submissions')
 await js('__erpQA.release()');await delay(100)
 assert.equal(await js('document.body.textContent.includes("Conexión verificada")'),true)
 assert.equal(await js('document.querySelectorAll(".erp-task").length'),0)
 assert.deepEqual(await js('__erpQA.counts()'),{checkCount:1,syncCount:0})
 console.log('PASS check succeeds without synchronizing or importing Tasks')
 await click('Consultar DocType Task');await delay(100)
 assert.equal(await js('document.body.textContent.includes("2501 Tasks")'),true)
 assert.equal(await js('document.querySelectorAll(".erp-task").length'),50)
 console.log('PASS 2501 Tasks are retained but only 50 cards mount initially')
 await click('Mostrar más');await delay(100)
 assert.equal(await js('document.querySelectorAll(".erp-task").length'),100)
 assert.equal(await js('document.querySelector(".erp-column h3").textContent.includes("2501")'),true)
 console.log('PASS show more extends the same column without a new ERP request')
 await js('__erpQA.fail()');await click('Probar conexión');await delay(50)
 await js('__erpQA.release()');await delay(100)
 assert.equal(await js('document.body.textContent.includes("QA conexión rechazada")'),true)
 assert.equal(await js('document.body.textContent.includes("Conexión verificada")'),false)
 assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Probar conexión")).disabled'),false)
 assert.equal(await js('document.querySelectorAll(".erp-task").length'),100)
 console.log('PASS error removes old success feedback and releases controls without resetting visible cards')
 w.destroy();app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
`)
try {
  execFileSync(process.execPath,['--check',main],{stdio:'pipe'})
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CROW_MCP_CONFIG
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(require('electron'),[main],{env,stdio:'inherit',windowsHide:true})
    const timer=setTimeout(()=>{child.kill();reject(new Error('ERP UI QA timed out'))},45000)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',code=>{clearTimeout(timer);resolve(code)})
  })
  if(code!==0)throw new Error('Electron ERP UI QA failed')
} finally {
  server.httpServer?.closeAllConnections();await server.close()
  if(dirname(resolve(temp))!==resolve(tmpdir()) || !temp.includes('crow-erp-ui-qa-'))throw new Error('Unexpected cleanup path')
  await rm(temp,{recursive:true,force:true})
}
