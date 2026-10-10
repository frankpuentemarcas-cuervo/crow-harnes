// Run explicitly: source-only Vite + isolated mock IPC; never builds or opens Crow's real profile.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { chromium } = process.env.CROW_QA_NODE_MODULES ? createRequire(resolve(process.env.CROW_QA_NODE_MODULES, '../package.json'))(resolve(process.env.CROW_QA_NODE_MODULES, 'playwright')) : require('playwright')
const server = await createServer({ configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:31517,strictPort:true} })
await server.listen()
const browser = await chromium.launch({ headless:true, ...(process.env.CROW_QA_BROWSER ? {executablePath:process.env.CROW_QA_BROWSER} : {}) })
const artifactRoot=resolve(process.env.CROW_QA_ARTIFACTS || 'tests/.qa-artifacts')
await mkdir(artifactRoot,{recursive:true})
const reports=[]
try {
 for(const [width,height] of (process.env.CROW_QA_ONLY_NARROW ? [] : [[1917,960],[1366,650],[1536,746],[1050,590]])) {
  const page=await browser.newPage({viewport:{width,height}})
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:31517/tests/fixtures/persistent-quota-ui.html',{waitUntil:'domcontentloaded'})
  await page.locator('.quota-dock-account').waitFor()
  await page.locator('.xterm-screen').waitFor()
  await page.waitForFunction(()=>window.__qa.calls.resize>0)
  const geometry=await page.evaluate(()=>{
   const bounds=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
   return {dock:bounds('.sidebar .account-usage-dock'),tree:bounds('.sidebar-scroll'),terminal:bounds('.terminal-surface'),files:bounds('.files-pane'),sidebar:bounds('.sidebar'),root:bounds('.app-shell'),scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,lastSize:window.__qa.sizes.at(-1)}
  })
  assert.equal(geometry.scrollWidth,width,'no viewport horizontal overflow')
  assert.equal(geometry.sidebar.width,280)
  assert.ok(geometry.dock.bottom<=height,'dock contained by client height')
  assert.ok(geometry.tree.bottom<=geometry.dock.y+1,'host tree never overlaps fixed accounts')
  assert.ok(geometry.terminal.width>250 && geometry.terminal.height>250,'terminal keeps useful work area')
  assert.ok(geometry.lastSize.cols>30 && geometry.lastSize.rows>10,'xterm fit uses viewport')
  assert.deepEqual(errors,[])
  await page.screenshot({path:resolve(artifactRoot,`crow-layout-${width}x${height}.png`)})
  const calls=await page.evaluate(()=>({...window.__qa.calls}))
  await page.getByRole('button',{name:'Administrar cuentas y cuotas'}).click()
  await page.getByRole('dialog').waitFor()
  assert.ok(await page.getByText('80 % usado',{exact:true}).isVisible())
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.account-usage-dialog').count(),0)
  assert.equal(await page.evaluate(()=>window.__qa.calls.list),calls.list,'modal does not create second account lifecycle')
  assert.equal(await page.evaluate(()=>window.__qa.calls.refresh),calls.refresh)
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Administrar cuentas y cuotas')
  await page.getByRole('button',{name:'Contraer proyectos'}).click()
  await page.locator('.workspace > .account-usage-dock.compact').waitFor()
  assert.ok(await page.locator('.workspace .quota-dock-account').isVisible())
  await page.getByRole('button',{name:'Mostrar proyectos'}).click()
  await page.getByRole('button',{name:'Mostrar archivos',exact:true}).click()
  assert.equal(await page.locator('.files-pane').count(),0)
  await page.getByRole('button',{name:'Mostrar archivos',exact:true}).click()
  await page.getByRole('button',{name:'Configuración e integraciones'}).click()
  for(const name of ['Gestionar hosts','Cuentas','Acceso móvil en red local','Buscar actualizaciones','Diagnóstico de alertas','Configurar IA · Free LLM']) assert.ok(await page.getByRole('button',{name,exact:true}).isVisible())
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Configuración e integraciones')
  reports.push({width,height,...geometry})
  await page.close()
 }
 let scrolls;
 if(!process.env.CROW_QA_ONLY_NARROW) {
 const many=await browser.newPage({viewport:{width:1366,height:650}})
 await many.goto('http://127.0.0.1:31517/tests/fixtures/persistent-quota-ui.html?accounts=30&projects=100&stale=1',{waitUntil:'domcontentloaded'})
 await many.locator('.quota-dock-account').last().waitFor({state:'attached'})
 assert.equal(await many.locator('.quota-dock-account').count(),30)
 assert.ok(await many.getByText('1 con cuota agotada',{exact:true}).isVisible())
 scrolls=await many.evaluate(()=>({tree:document.querySelector('.sidebar-scroll').scrollHeight>document.querySelector('.sidebar-scroll').clientHeight,accounts:document.querySelector('.quota-dock-list').scrollHeight>document.querySelector('.quota-dock-list').clientHeight}))
 assert.deepEqual(scrolls,{tree:true,accounts:true})
 await many.locator('.quota-dock-account').last().scrollIntoViewIfNeeded()
 assert.ok(await many.getByText('Cuenta QA 29',{exact:true}).isVisible())
 await many.screenshot({path:resolve(artifactRoot,'crow-layout-many-accounts.png')})
 await many.close()
 }
 const narrow=await browser.newPage({viewport:{width:700,height:650}})
 await narrow.goto('http://127.0.0.1:31517/tests/fixtures/persistent-quota-ui.html?accounts=0',{waitUntil:'domcontentloaded'})
 await narrow.getByRole('button',{name:'Mostrar proyectos'}).click()
 await narrow.getByRole('button',{name:/^SORTER/}).waitFor({state:'visible'})
 assert.ok(await narrow.getByRole('button',{name:/^SORTER/}).isVisible())
 await narrow.getByRole('button',{name:'Contraer proyectos'}).click()
 await narrow.locator('.workspace .account-usage-dock.compact').waitFor()
 assert.ok(await narrow.locator('.workspace').getByText('Sin cuentas registradas; uso desconocido.',{exact:true}).isVisible())
 const failed=await browser.newPage({viewport:{width:1366,height:650}})
 await failed.goto('http://127.0.0.1:31517/tests/fixtures/persistent-quota-ui.html?error=1',{waitUntil:'domcontentloaded'})
 await failed.locator('.quota-dock-error').waitFor()
 assert.ok(await failed.locator('.quota-dock-error').isVisible())
 console.log(JSON.stringify({status:'PASS',viewports:reports,manyAccounts:scrolls,artifacts:artifactRoot},null,2))
} finally { await browser.close();await server.close() }
