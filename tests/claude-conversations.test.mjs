import test from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeConversationService } from '../src/main/claude-conversations.ts'

const id='c'.repeat(32), terminal='a'.repeat(32), requestId='11111111-1111-4111-8111-111111111111'
function harness() {
  const record={id,root:'/project',name:'Diseño',mode:'normal',status:'available',createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:00Z'}
  const session={id:terminal,root:'/project',ownerId:'actor',agent:'claude',mode:'normal',state:'running',claudeConversationId:id}
  const calls=[], names={}; let generation=0
  const h={record,session,calls,names,actor:'actor',online:true,project:{id:'project',hostId:'host',root:'/project'},rows:[record],sessions:[],result:{conversation:{...record,status:'pending',sessionId:terminal},session,state:'pending'}}
  h.current={status:()=>h.online?'connected':'disconnected',api:async(method,path,body)=>{calls.push([method,path,body]); if(h.remote) return h.remote(method,path,body); if(path==='/api/claude-conversations')return h.rows; if(path==='/api/sessions')return h.sessions; if(path.endsWith('/name'))return {...record,name:body.name};return h.result}}
  h.service=new ClaudeConversationService({project:key=>key===h.project.id?h.project:undefined,connection:()=>h.current,generation:()=>generation,authorize:async()=>({actorId:h.actor,root:h.project.root}),name:(_host,key)=>names[key],rename:(_host,key,name)=>{names[key]=name}})
  h.change=()=>{generation++};return h
}
test('catalogue projects exact permitted root, strips native IDs and never starts a terminal',async()=>{
 const h=harness();h.rows=[{...h.record,nativeId:'secret-native'}, {...h.record,id:'d'.repeat(32),root:'/project-other'}]
 assert.deepEqual(await h.service.list('host','project'),[h.record]);assert.deepEqual(h.calls.map(call=>call.slice(0,2)),[['GET','/api/claude-conversations'],['GET','/api/sessions']])
})
test('resume only uses logical record endpoint + durable UUID, applies name before returning pending',async()=>{
 const h=harness();const result=await h.service.resume('host','project',id,requestId)
 assert.equal(result.state,'pending');assert.equal(h.names[terminal],'Diseño')
 assert.deepEqual(h.calls.find(call=>call[0]==='POST'),['POST',`/api/claude-conversations/${id}/resume`,{requestId}])
 assert.equal(h.calls.some(call=>/continue|chat\/submit/.test(call[1])),false)
})
test('invalid IDs, offline hosts and unknown project never reach resume',async()=>{
 for(const args of [['host','project','../../native',requestId],['host','project',id,'invalid'],['host','missing',id,requestId],['other','project',id,requestId]]){const h=harness();await assert.rejects(h.service.resume(...args));assert.equal(h.calls.length,0)}
 const h=harness();h.online=false;await assert.rejects(h.service.resume('host','project',id,requestId),/Conectá/);assert.equal(h.calls.length,0)
})
test('missing/unavailable history fails closed and old crowd has actionable upgrade error',async()=>{
 for(const status of ['unavailable','missing']){const h=harness();h.rows=status==='missing'?[]:[{...h.record,status}];await assert.rejects(h.service.resume('host','project',id,requestId));assert.equal(h.calls.some(call=>call[0]==='POST'),false)}
 const h=harness();h.remote=async()=>{throw Object.assign(new Error('404 page not found'),{status:404})};await assert.rejects(h.service.list('host','project'),/Actualizá crowd para reanudar conversaciones/)
})
test('returned foreign owner, wrong root, mismatched record and unconfirmed ready are rejected',async()=>{
 for(const change of [h=>{h.session.root='/other'},h=>{h.session.ownerId='foreign'},h=>{h.session.claudeConversationId='d'.repeat(32)},h=>{h.result.state='ready'}]){const h=harness();change(h);await assert.rejects(h.service.resume('host','project',id,requestId));assert.equal(h.names[terminal],undefined)}
})
test('authorization generation or actor changes invalidate late catalogue and resume responses',async()=>{
 for(const change of [h=>h.change(),h=>{h.actor='replacement'},h=>{h.project.root='/other'},h=>{h.online=false}]){const h=harness();h.remote=async(method,path)=>{if(method==='POST'){change(h);return h.result}return path==='/api/sessions'?[]:h.rows};await assert.rejects(h.service.resume('host','project',id,requestId));assert.equal(h.names[terminal],undefined)}
})
test('double resume coalesces one POST and existing active terminal is returned without new launch',async()=>{
 const h=harness();let release;h.remote=async(method,path)=>{if(method==='POST'){await new Promise(resolve=>{release=resolve});return h.result}return path==='/api/sessions'?[]:h.rows}
 const a=h.service.resume('host','project',id,requestId),b=h.service.resume('host','project',id,requestId);await new Promise(resolve=>setImmediate(resolve));release();await Promise.all([a,b]);assert.equal(h.calls.filter(call=>call[0]==='POST').length,1)
 const live=harness();live.rows=[{...live.record,status:'active',sessionId:terminal}];live.sessions=[live.session];assert.equal((await live.service.resume('host','project',id,requestId)).session.id,terminal);assert.equal(live.calls.some(call=>call[0]==='POST'),false)
})
test('catalogue name restores new terminal alias after restart and bridges only trusted mapped legacy alias',async()=>{
 const h=harness();h.rows=[{...h.record,status:'active',sessionId:terminal}];h.sessions=[h.session];await h.service.list('host','project');assert.equal(h.names[terminal],'Diseño')
 h.rows[0].name='';h.names[terminal]='Legacy QA';const rows=await h.service.list('host','project');assert.equal(rows[0].name,'Legacy QA');assert.deepEqual(h.calls.find(call=>call[0]==='POST'),['POST',`/api/claude-conversations/${id}/name`,{name:'Legacy QA'}])
})
test('forget removes only inactive catalogue metadata, never native history or terminal APIs',async()=>{
 const h=harness();await h.service.forget('host','project',id);assert.deepEqual(h.calls.at(-1).slice(0,2),['DELETE',`/api/claude-conversations/${id}`]);h.rows=[{...h.record,status:'pending',sessionId:terminal}];await assert.rejects(h.service.forget('host','project',id));assert.equal(h.calls.filter(call=>call[0]==='DELETE').length,1)
})

test('terminal alias is saved durably before deletion and mismatch never writes a name',async()=>{
 const h=harness();h.rows=[{...h.record,status:'active',sessionId:terminal}];h.sessions=[h.session];h.names[terminal]='Terminal QA'
 await h.service.preserveTerminalName('host','project',h.session)
 assert.deepEqual(h.calls.filter(c=>c[0]==='POST').at(-1),['POST',`/api/claude-conversations/${id}/name`,{name:'Terminal QA'}])
 const other=harness();other.session.ownerId='another';await assert.rejects(other.service.preserveTerminalName('host','project',other.session));assert.equal(other.calls.some(c=>c[0]==='POST'),false)
})

test('late history read never overwrites a newer explicit terminal alias',async()=>{
 const h=harness();h.rows=[{...h.record,status:'active',sessionId:terminal}];h.sessions=[h.session]
 let release;h.remote=async(_method,path)=>{if(path==='/api/sessions'){await new Promise(resolve=>{release=resolve});return h.sessions}return h.rows}
 const read=h.service.list('host','project');await new Promise(resolve=>setImmediate(resolve));h.names[terminal]='Nombre más nuevo';release();await read;assert.equal(h.names[terminal],'Nombre más nuevo')
})

test('removing an older replaced terminal never renames or blocks its current conversation',async()=>{
 const h=harness();h.rows=[{...h.record,status:'active',sessionId:'b'.repeat(32)}];h.names[terminal]='Old terminal name'
 await h.service.preserveTerminalName('host','project',h.session)
 assert.equal(h.calls.some(c=>c[0]==='POST'),false)
 h.rows=[];await h.service.preserveTerminalName('host','project',h.session);assert.equal(h.calls.some(c=>c[0]==='POST'),false)
})
