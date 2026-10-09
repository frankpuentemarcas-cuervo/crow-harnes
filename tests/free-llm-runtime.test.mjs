import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { FreeLLMRuntime, probeFreeLLM, findFreeLLMExecutable, launchFreeLLM } from '../src/main/free-llm-runtime.ts'
import { freeLLMStartupReady } from '../src/shared/free-llm-startup.ts'
import { EventEmitter } from 'node:events'

const settings = () => ({ enabled: true, baseURL: 'http://127.0.0.1:31415/v1', autoOpenFreeLLM: true })
const pause = () => new Promise(resolve => setImmediate(resolve))
test('startup waits for all SSH dialogs and attempts to settle; cached keys/no hosts also work', () => {
  const ready = { loaded:true, enabled:true, busy:false, pending:0, hostIds:['a','b'], statuses:{a:'connected',b:'connected'} }
  assert.equal(freeLLMStartupReady(ready),true)
  for (const patch of [{loaded:false},{enabled:false},{busy:true},{pending:1},{statuses:{a:'connected',b:'connecting'}},{statuses:{a:'connected'}}]) assert.equal(freeLLMStartupReady({...ready,...patch}),false)
  assert.equal(freeLLMStartupReady({...ready,hostIds:[],statuses:{}}),true)
  assert.equal(freeLLMStartupReady({...ready,statuses:{a:'connected',b:'auth-required'}}),true) // dialog canceled
})
test('probe uses bounded local unauthenticated GET only; reachable is not model validation', async () => {
  const server = createServer((request,response) => { assert.equal(request.url,'/v1/models'); assert.equal(request.method,'GET'); assert.equal(request.headers.authorization,undefined); response.writeHead(401); response.end('{}') })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  try {
    assert.equal(await probeFreeLLM(`http://127.0.0.1:${server.address().port}/v1`),true)
    await assert.rejects(probeFreeLLM('https://external.example/v1'))
    assert.equal(await probeFreeLLM(settings().baseURL,undefined,async()=>new Response('',{status:404})),false)
    assert.equal(await probeFreeLLM(settings().baseURL,undefined,async()=>{throw new Error('offline')}),false)
  } finally { await new Promise(resolve=>server.close(resolve)) }
})
test('disabled AI never probes or opens; an already available API never launches', async () => {
  let probes=0, launches=0
  let enabled=false
  const runtime=new FreeLLMRuntime(()=>({...settings(),enabled}),()=>{}, {probe:async()=>{probes++;return true},launch:async()=>{launches++}})
  assert.equal((await runtime.ensure()).state,'disabled'); assert.equal(probes,0)
  enabled=true
  assert.equal((await runtime.ensure()).state,'available'); assert.equal(probes,1); assert.equal(launches,0)
})
test('concurrent startup checks launch only once, poll readiness and report progress', async () => {
  let probes=0, launches=0
  const states=[]
  const runtime=new FreeLLMRuntime(settings,status=>states.push(status.state),{probe:async()=>++probes>=3,find:()=> 'C:\\Apps\\FreeLLMAPI.exe',launch:async()=>{launches++},sleep:async()=>{},attempts:3})
  const [a,b]=await Promise.all([runtime.ensure(),runtime.ensure()])
  assert.equal(a.state,'available'); assert.deepEqual(a,b); assert.equal(launches,1)
  assert.ok(states.includes('checking'))
})
test('manual mode, missing installation, failed launch and inactive API warn without blocking or respawning', async () => {
  for (const mode of ['manual','missing','failed','inactive']) {
    let launches=0
    const runtime=new FreeLLMRuntime(()=>({...settings(),autoOpenFreeLLM:mode!=='manual'}),()=>{}, {probe:async()=>false,find:()=>mode==='missing'?undefined:'C:\\Apps\\FreeLLMAPI.exe',launch:async()=>{launches++;if(mode==='failed')throw new Error('private-path')},sleep:async()=>{},attempts:2})
    const result=await runtime.ensure()
    assert.equal(result.state,'unavailable'); assert.ok(!result.detail.includes('private-path'))
    await runtime.ensure(); assert.equal(launches,['failed','inactive'].includes(mode)?1:0)
  }
})
test('disable/stop cancels pending startup without opening an app or late success', async () => {
  let resolveProbe, launches=0
  let config=settings()
  const runtime=new FreeLLMRuntime(()=>config,()=>{}, {probe:()=>new Promise(resolve=>{resolveProbe=resolve}),find:()=> 'C:\\Apps\\FreeLLMAPI.exe',launch:async()=>{launches++}})
  const pending=runtime.ensure(); await pause()
  config={...config,enabled:false}; runtime.reset(); resolveProbe(false)
  assert.equal((await pending).state,'idle'); assert.equal(launches,0)
})
test('discovery stays in fixed installation paths; launching uses no shell or arguments', async () => {
  const executable='C:\\Users\\QA\\AppData\\Local\\Programs\\freellmapi-desktop\\FreeLLMAPI.exe'
  assert.equal(findFreeLLMExecutable({LOCALAPPDATA:'C:\\Users\\QA\\AppData\\Local'},p=>p===executable),executable)
  let args
  const child=new EventEmitter(); child.unref=()=>{}
  await launchFreeLLM(executable,(...input)=>{args=input;setImmediate(()=>child.emit('spawn'));return child})
  assert.deepEqual(args[1],[]); assert.equal(args[2].shell,false); assert.equal(args[2].windowsHide,true)
  await assert.rejects(launchFreeLLM('cmd.exe'))
  await assert.rejects(launchFreeLLM('C:\\Apps\\Other.exe'))
  await assert.rejects(launchFreeLLM('//remote/share/FreeLLMAPI.exe'))
  assert.equal(findFreeLLMExecutable({LOCALAPPDATA:'relative'},()=>true),undefined)
  assert.equal(findFreeLLMExecutable({LOCALAPPDATA:'\\\\remote\\share'},()=>true),undefined)
})

test('closing Crow cancels a launched-app wait without late warnings or more launches', async () => {
  const states=[]
  let sleeping, launches=0
  const runtime=new FreeLLMRuntime(settings,status=>states.push(status), {probe:async()=>false,find:()=> 'C:\\Apps\\FreeLLMAPI.exe',launch:async()=>{launches++},sleep:(_ms,signal)=>new Promise((resolve,reject)=>{sleeping=true;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})})})
  const pending=runtime.ensure()
  while(!sleeping)await pause()
  const count=states.length
  runtime.stop();await pending
  assert.equal(launches,1);assert.equal(states.length,count)
})
