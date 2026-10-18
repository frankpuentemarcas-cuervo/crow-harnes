import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Store } from '../src/main/store.ts'
import { BridgeRegistry } from '../src/main/bridge-registry.ts'
import { BridgeService } from '../src/main/bridge-service.ts'
import { BridgeGateway } from '../src/main/bridge-gateway.ts'
import { authenticate, policySchema } from '../src/main/bridge-policy.ts'

async function freePort() {
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'crow-bridge-'))
  const workspace = new Store(dir)
  const hosts = [0, 1, 2].map((index) => workspace.saveHost({ name: `Test ${index}`, target: `test@fake-${index}`, identity: 'private-key-marker', port: 22, remotePort: 47321 }).hosts[index])
  const projects = hosts.map((host, index) => workspace.saveProject({ hostId: host.id, name: `Probe ${index}`, root: `/empty-test-${index}` }).projects[index])
  const tokens = [0, 1, 2].map(() => randomBytes(32).toString('base64url'))
  const sessions = [0, 1].map((index) => ({ id: String(index + 1).repeat(32), root: projects[index].root, agent: 'claude', mode: 'normal', hooksActive: true, state: 'running', agentState: 'waiting', seq: 0 }))
  const hash = (token) => createHash('sha256').update(token).digest('hex')
  const clients = [
    { id: 'client-0', tokenSha256: hash(tokens[0]), grants: [{ hostId: hosts[0].id, projectId: projects[0].id, sessionId: sessions[0].id, operations: ['discover', 'register', 'hello', 'result'] }] },
    { id: 'client-1', tokenSha256: hash(tokens[1]), grants: [{ hostId: hosts[1].id, projectId: projects[1].id, sessionId: sessions[1].id, operations: ['discover', 'register', 'hello', 'result'] }] },
    // Authenticated create-only client: no terminal grants and no project grant.
    { id: 'client-create', tokenSha256: hash(tokens[2]), grants: [] }
  ]
  // Synthetic runtime boundary: never opens SSH, a shell, files or a real agent.
  const remotes = hosts.map((_, index) => {
    const sessionList = index < sessions.length ? [sessions[index]] : []
    return {
      availability: 'connected', sends: 0, creates: 0, tasks: new Map(), creations: new Map(), mismatch: false,
      legacyHealth: false,
      status() { return this.availability },
      async api(method, path, body) {
        if (this.availability !== 'connected') throw new Error('secret-network-error-marker')
        if (path === '/api/access/me') return this.identity || { role: 'legacy' }
        if (path === '/api/health') return { bridgeHelloVersion: 1, bridgeCreateVersion: this.legacyHealth ? 0 : 1 }
        if (path === '/api/sessions' && method === 'GET') return sessionList.map((item) => structuredClone(item))
        if (path === '/api/sessions' && method === 'POST') {
          assert.equal(body.mode, 'normal')
          assert.equal(typeof body.root, 'string')
          const key = body.requestKey
          if (!this.creations.has(key)) {
            this.creates++
            const created = { id: createHash('sha256').update(key).digest('hex').slice(0, 32), root: body.root, agent: body.agent, mode: body.mode, hooksActive: true, state: 'running', agentState: 'waiting', seq: 0 }
            this.creations.set(key, created)
            sessionList.push(created)
          }
          const record = this.creations.get(key)
          if (record.root !== body.root || record.agent !== body.agent || record.mode !== body.mode) throw new Error('secret-conflict-marker')
          return structuredClone(record)
        }
        if (path === '/api/bridge/hello') {
          assert.equal(method, 'POST')
          assert.equal(body.message, 'Hola')
          assert.equal(body.sessionId, sessionList[0].id)
          assert.equal(body.root, sessionList[0].root)
          if (!this.tasks.has(body.taskId)) {
            this.sends++
            const now = new Date().toISOString()
            this.tasks.set(body.taskId, { id: body.taskId, sessionId: sessionList[0].id, root: sessionList[0].root, state: 'pending', createdAt: now, updatedAt: now })
          }
          return structuredClone(this.tasks.get(body.taskId))
        }
        const task = this.tasks.get(path.split('/').at(-1))
        if (!task) throw new Error('not found')
        const value = structuredClone(task)
        if (this.mismatch) value.sessionId = 'f'.repeat(32)
        return value
      }
    }
  })
  const connection = (hostId) => {
    const index = hosts.findIndex((host) => host.id === hostId)
    assert.notEqual(index, -1)
    return remotes[index]
  }
  const service = () => new BridgeService(new BridgeRegistry(dir), workspace, connection)
  const cleanup = () => {
    assert.equal(resolve(dirname(dir)), resolve(tmpdir()))
    assert.ok(basename(dir).startsWith('crow-bridge-'))
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, workspace, hosts, projects, sessions, clients, tokens, remotes, service, cleanup }
}

async function connect(url, token, name = 'isolated-mcp-test') {
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} })
  // A restarted client process has a fresh socket pool. Force fresh connections
  // here because both synthetic clients/restarts run in the same Node process.
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: 'close' } } })
  await client.connect(transport).catch((error) => { throw new Error(`MCP initialize (${name}): ${error.message}`, { cause: error }) })
  return client
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }).catch((error) => { throw new Error(`MCP ${name}: ${error.message}`, { cause: error }) })
  assert.ok(!result.isError, result.content?.[0]?.text)
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  return result.structuredContent
}

test('MCP HTTP: discover → register → Hola → correlate → disconnect/restart/recover, with client isolation', async () => {
  const f = fixture()
  const policy = { version: 1, port: await freePort(), clients: f.clients }
  let gateway = new BridgeGateway(policy, f.service())
  let client, other
  try {
    const url = await gateway.start()
    client = await connect(url, f.tokens[0])
    other = await connect(url, f.tokens[1], 'another-compatible-client')
    assert.equal(client.getServerVersion().name, 'crow-harness')
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['crow_context', 'crow_create_terminal', 'crow_get_result', 'crow_register_orchestrator', 'crow_send_hello'])
    const context = await call(client, 'crow_context')
    // Creation is catalog-wide, so every catalog host is listed for every client;
    // terminal/orchestrator/request isolation stays grant-scoped below.
    assert.deepEqual(context.hosts.map((host) => host.id), [f.hosts[0].id, f.hosts[1].id, f.hosts[2].id])
    assert.equal(context.capabilities.arbitraryTasks, false)
    assert.ok(context.hosts[0].observedAt)
    assert.equal(context.hosts[0].bridgeHello, 'available')
    assert.equal(client.getServerCapabilities().resources, undefined)
    assert.deepEqual(context.clientPreferences, { replyLanguage: 'es', pollingSeconds: 10 })
    assert.ok(!JSON.stringify(context).includes('private-key-marker'))
    assert.ok(!JSON.stringify(context).includes('test@fake-'))
    const orchestrator = await call(client, 'crow_register_orchestrator', { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id })
    assert.deepEqual(await call(client, 'crow_register_orchestrator', { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id }), orchestrator)
    const requestId = randomUUID()
    assert.ok((await client.callTool({ name: 'crow_send_hello', arguments: { orchestratorId: orchestrator.id, requestId, message: 'execute deployment' } })).isError)
    assert.equal(f.remotes[0].sends, 0)
    const [hello] = await Promise.all([call(client, 'crow_send_hello', { orchestratorId: orchestrator.id, requestId }), call(client, 'crow_send_hello', { orchestratorId: orchestrator.id, requestId })])
    assert.equal(hello.state, 'pending')
    assert.equal(hello.terminal.sessionId, f.sessions[0].id)
    await Promise.all([call(client, 'crow_send_hello', { orchestratorId: orchestrator.id, requestId }), call(client, 'crow_send_hello', { orchestratorId: orchestrator.id, requestId })])
    assert.equal(f.remotes[0].sends, 1)
    const task = [...f.remotes[0].tasks.values()][0]
    task.state = 'completed'; task.result = 'Hola'; task.updatedAt = new Date().toISOString()
    f.remotes[0].mismatch = true
    assert.notEqual((await call(client, 'crow_get_result', { requestId })).state, 'completed')
    f.remotes[0].mismatch = false
    const result = await call(client, 'crow_get_result', { requestId })
    assert.equal(result.state, 'completed'); assert.equal(result.result, 'Hola'); assert.equal(result.freshness, 'live')
    assert.ok((await other.callTool({ name: 'crow_get_result', arguments: { requestId } })).isError)
    assert.ok((await client.callTool({ name: 'crow_register_orchestrator', arguments: { hostId: f.hosts[1].id, projectId: f.projects[1].id, sessionId: f.sessions[1].id } })).isError)
    await client.close(); client = undefined
    await other.close(); other = undefined
    await gateway.stop()
    gateway = new BridgeGateway(policy, f.service())
    await gateway.start()
    client = await connect(url, f.tokens[0])
    const recovered = await call(client, 'crow_context')
    assert.equal(recovered.hosts[0].orchestrator.id, orchestrator.id)
    assert.equal(recovered.requests[0].requestId, requestId)
    assert.equal((await call(client, 'crow_get_result', { requestId })).result, 'Hola')
    await call(client, 'crow_send_hello', { orchestratorId: orchestrator.id, requestId })
    assert.equal(f.remotes[0].sends, 1)
    f.remotes[0].availability = 'disconnected'
    assert.ok((await client.callTool({ name: 'crow_get_result', arguments: { requestId } })).isError)
    const offline = await call(client, 'crow_context')
    // Offline hosts still list every catalog project; canCreate communicates that
    // creation is unavailable right now instead of hiding the project.
    assert.equal(offline.hosts[0].projects.length, 1)
    assert.equal(offline.hosts[0].projects[0].id, f.projects[0].id)
    assert.equal(offline.hosts[0].projects[0].canCreate, false)
    assert.equal(offline.hosts[0].availability, 'disconnected')
    assert.equal(offline.hosts[0].bridgeCreate, false)
    assert.equal(offline.requests.length, 0)
    const persisted = readFileSync(join(f.dir, 'bridge.json'), 'utf8')
    for (const marker of [...f.tokens, 'private-key-marker', 'secret-network-error-marker']) assert.ok(!persisted.includes(marker))
  } finally { await client?.close(); await other?.close(); await gateway.stop(); f.cleanup() }
})

test('MCP requires independent bearer credentials, rejects DNS rebinding/origins and has no anonymous endpoint', async () => {
  const f = fixture()
  const policy = { version: 1, port: await freePort(), clients: f.clients }
  const gateway = new BridgeGateway(policy, f.service())
  try {
    const url = await gateway.start()
    for (const [headers, expected] of [
      [{}, 401], [{ Authorization: 'Bearer invalid' }, 401],
      [{ Authorization: `Bearer ${f.tokens[0]}`, Origin: 'https://evil.example' }, 403]
    ]) assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, expected)
    const headers = { Authorization: `Bearer ${f.tokens[0]}` }
    const rebinding = await new Promise((resolve, reject) => {
      const request = httpRequest(url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
      request.on('error', reject); request.end('{}')
    })
    assert.equal(rebinding, 403)
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(16_385) })).status, 413)
    const handshake = await fetch(url, { method: 'POST', headers: { ...headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-http-test', version: '1' } } }) })
    assert.equal((await handshake.json()).result.protocolVersion, '2025-11-25')
    assert.equal((await fetch(url, { headers })).status, 405)
    assert.equal((await fetch(url + '/unknown', { method: 'POST', headers })).status, 404)
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'malformed' })).status, 400)
  } finally { await gateway.stop(); f.cleanup() }
})

test('registration/dispatch fail closed on changed folders, bypass, revoked operations and corrupt registry', async () => {
  const f = fixture()
  try {
    const s = f.service(), c = f.clients[0]
    f.sessions[0].mode = 'bypass'
    await assert.rejects(s.register(c, f.hosts[0].id, f.projects[0].id, f.sessions[0].id))
    f.sessions[0].mode = 'normal'
    const orchestrator = await s.register(c, f.hosts[0].id, f.projects[0].id, f.sessions[0].id)
    const revoked = structuredClone(c); revoked.grants[0].operations = ['discover']
    await assert.rejects(s.hello(revoked, orchestrator.id, randomUUID()))
    f.workspace.saveProject({ ...f.projects[0], root: '/different' })
    await assert.rejects(s.hello(c, orchestrator.id, randomUUID()))
    assert.equal(f.remotes[0].sends, 0)
    assert.equal((await s.context(c)).hosts[0].orchestrator, undefined)
    f.workspace.saveProject(f.projects[0])
    f.workspace.saveHost({ ...f.hosts[0], target: 'test@changed-destination' })
    await assert.rejects(s.hello(c, orchestrator.id, randomUUID()))
    assert.equal((await s.context(c)).hosts[0].orchestrator, undefined)
    writeFileSync(join(f.dir, 'bridge.json'), 'broken')
    assert.throws(() => f.service())
    assert.throws(() => policySchema.parse({ version: 1, port: 47422, clients: [c, c] }))
    assert.equal(authenticate({ clients: [c] }, 'Bearer unknown'), undefined)
  } finally { f.cleanup() }
})

test('endpoint changes during registration cannot bind an old server response to the new host', async () => {
  const f = fixture()
  try {
    const remote = f.remotes[0], original = remote.api.bind(remote)
    remote.api = async (...args) => {
      const response = await original(...args)
      f.workspace.saveHost({ ...f.hosts[0], target: 'test@new-endpoint' })
      return response
    }
    await assert.rejects(f.service().register(f.clients[0], f.hosts[0].id, f.projects[0].id, f.sessions[0].id))
    assert.equal(new BridgeRegistry(f.dir).snapshot().orchestrators.length, 0)
  } finally { f.cleanup() }
})

test('lost POST response survives restart and retries the same remote id, never duplicate work', async () => {
  const f = fixture()
  try {
    let service = f.service()
    const orchestrator = await service.register(f.clients[0], f.hosts[0].id, f.projects[0].id, f.sessions[0].id)
    const remote = f.remotes[0], original = remote.api.bind(remote)
    remote.api = async (...args) => {
      const response = await original(...args)
      if (args[0] === 'POST') throw new Error('secret-network-error-marker')
      return response
    }
    const requestId = randomUUID()
    assert.equal((await service.hello(f.clients[0], orchestrator.id, requestId)).state, 'uncertain')
    assert.equal(remote.sends, 1)
    service = f.service()
    assert.equal((await service.context(f.clients[0])).requests[0].requestId, requestId)
    remote.api = original
    assert.equal((await service.hello(f.clients[0], orchestrator.id, requestId)).state, 'pending')
    assert.equal(remote.sends, 1)
    const task = [...remote.tasks.values()][0]
    task.state = 'completed'; task.result = 'Hola'; task.updatedAt = new Date().toISOString()
    assert.equal((await service.result(f.clients[0], requestId)).result, 'Hola')
  } finally { f.cleanup() }
})

test('cached MCP results cannot cross Crow identities, even if the same terminal remains visible', async () => {
  const f = fixture()
  try {
    const remote = f.remotes[0], client = f.clients[0]
    remote.identity = { role: 'member', id: 'actor-a' }
    const service = f.service(), orchestrator = await service.register(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id)
    const requestId = randomUUID()
    await service.hello(client, orchestrator.id, requestId)
    const task = [...remote.tasks.values()][0]
    task.state = 'completed'; task.result = 'Hola'; task.updatedAt = new Date().toISOString()
    assert.equal((await service.result(client, requestId)).result, 'Hola')
    remote.identity = { role: 'member', id: 'actor-b' }
    const restarted = f.service()
    await assert.rejects(restarted.result(client, requestId), /identidad Crow/)
    await assert.rejects(restarted.hello(client, orchestrator.id, requestId), /identidad Crow/)
    const context = await restarted.context(client)
    assert.deepEqual(context.requests, [])
    assert.equal(context.hosts[0].orchestrator, undefined)
    assert.equal(remote.sends, 1)
  } finally { f.cleanup() }
})

test('MCP refuses writable operations for admin read-only foreign terminals', async () => {
  const f = fixture()
  try {
    f.remotes[0].identity = { role: 'admin', id: 'admin' }
    f.sessions[0].readOnly = true
    await assert.rejects(f.service().register(f.clients[0], f.hosts[0].id, f.projects[0].id, f.sessions[0].id), /Terminal no permitida/)
    assert.equal(f.remotes[0].sends, 0)
  } finally { f.cleanup() }
})

test('MCP crow_create_terminal creates an empty normal terminal, rejects bad input and stays discoverable', async () => {
  const f = fixture()
  const policy = { version: 1, port: await freePort(), clients: f.clients }
  const gateway = new BridgeGateway(policy, f.service())
  let client
  try {
    const url = await gateway.start()
    client = await connect(url, f.tokens[2], 'creator-client')
    const tools = await client.listTools()
    assert.ok(tools.tools.some((tool) => tool.name === 'crow_create_terminal'))
    const schema = tools.tools.find((tool) => tool.name === 'crow_create_terminal').inputSchema
    assert.deepEqual([...schema.required].sort(), ['agent', 'hostId', 'projectId', 'requestKey'])
    // Strict schema: arbitrary paths, unsupported agents and non-UUID keys are rejected.
    for (const args of [
      { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey: randomUUID(), root: '/etc' },
      { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey: randomUUID(), mode: 'bypass' },
      { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'shell', requestKey: randomUUID() },
      { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'agy', requestKey: randomUUID() },
      { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey: 'not-a-uuid' }
    ]) assert.ok((await client.callTool({ name: 'crow_create_terminal', arguments: args })).isError)
    assert.equal(f.remotes[2].creates, 0)
    // Every catalog project is visible for creation before any terminal exists,
    // even though this authenticated client has no grants and no project grant.
    const before = await call(client, 'crow_context')
    const beforeHost = before.hosts.find((host) => host.id === f.hosts[2].id)
    const beforeProject = beforeHost.projects.find((project) => project.id === f.projects[2].id)
    assert.equal(beforeProject.canCreate, true)
    assert.deepEqual(beforeProject.terminals, [])
    const requestKey = randomUUID()
    const created = await call(client, 'crow_create_terminal', { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'codex', requestKey })
    assert.equal(created.requestKey, requestKey)
    assert.equal(created.agent, 'codex')
    assert.equal(created.mode, 'normal')
    assert.equal(created.state, 'running')
    assert.equal(f.remotes[2].creates, 1)
    const retried = await call(client, 'crow_create_terminal', { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'codex', requestKey })
    assert.equal(retried.sessionId, created.sessionId)
    assert.equal(f.remotes[2].creates, 1)
    const context = await call(client, 'crow_context')
    const project = context.hosts.find((host) => host.id === f.hosts[2].id).projects.find((item) => item.id === f.projects[2].id)
    assert.equal(project.canCreate, true)
    assert.equal(project.terminals.length, 1)
    assert.equal(project.terminals[0].sessionId, created.sessionId)
    assert.equal(project.terminals[0].created, true)
    // Until the owner renames it, a created session keeps the explicit fallback.
    assert.equal(project.terminals[0].name, 'Terminal nueva')
    assert.ok(!JSON.stringify(context).includes('private-key-marker'))
  } finally { await client?.close(); await gateway.stop(); f.cleanup() }
})

test('any authenticated client lists and creates in a catalog project without project grants, rejecting bad destinations before POST', async () => {
  const f = fixture()
  try {
    // Old policy files parse unchanged; creation no longer needs projectGrants,
    // which stays readable but ignored for authorization.
    const legacy = policySchema.parse({ version: 1, port: 47500, clients: [f.clients[0]] })
    assert.deepEqual(legacy.clients[0].projectGrants, [])
    assert.ok(!JSON.stringify(legacy.clients[0].grants).includes('createTerminal'))
    // A client with no grants at all is a valid create-only client.
    const bare = policySchema.parse({ version: 1, port: 47500, clients: [{ id: 'bare', tokenSha256: f.clients[0].tokenSha256, grants: [] }] })
    assert.deepEqual(bare.clients[0].grants, [])
    assert.deepEqual(bare.clients[0].projectGrants, [])
    const service = f.service()
    // No project grant: a client granted only on host 0 still lists and creates
    // in host 2, a catalog host/project it was never granted.
    const listed = await service.context(f.clients[0])
    const host = listed.hosts.find((item) => item.id === f.hosts[2].id)
    assert.equal(host.projects.find((project) => project.id === f.projects[2].id).canCreate, true)
    const created = await service.createTerminal(f.clients[0], f.hosts[2].id, f.projects[2].id, 'claude', randomUUID())
    assert.ok(created.sessionId)
    assert.equal(f.remotes[2].creates, 1)
    // Unknown host, unknown project, mismatched host/project and unsupported
    // agent are all rejected before any session POST.
    await assert.rejects(service.createTerminal(f.clients[2], randomUUID(), f.projects[2].id, 'claude', randomUUID()), /no autorizado/)
    await assert.rejects(service.createTerminal(f.clients[2], f.hosts[2].id, randomUUID(), 'claude', randomUUID()), /no autorizado/)
    await assert.rejects(service.createTerminal(f.clients[2], f.hosts[0].id, f.projects[2].id, 'claude', randomUUID()), /no autorizado/)
    await assert.rejects(service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[0].id, 'claude', randomUUID()), /no autorizado/)
    await assert.rejects(service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'shell', randomUUID()), /Claude o Codex/)
    assert.equal(f.remotes[2].creates, 1)
    assert.equal(f.remotes[0].creates, 0)
  } finally { f.cleanup() }
})

test('legacy runtime without bridgeCreate support lists projects with canCreate false and gets zero POSTs', async () => {
  const f = fixture()
  try {
    const remote = f.remotes[2], service = f.service(), client = f.clients[2]
    remote.legacyHealth = true
    // A second catalog project on the same host proves the whole catalog is
    // listed, not only a single project.
    const extra = f.workspace.saveProject({ hostId: f.hosts[2].id, name: 'Probe extra', root: '/empty-test-extra' }).projects.at(-1)
    // Context reports the runtime capability as false and never as creatable for
    // that host, while the catalog projects stay listed and other catalog hosts
    // stay creatable.
    const context = await service.context(client)
    const host = context.hosts.find((item) => item.id === f.hosts[2].id)
    assert.equal(host.bridgeCreate, false)
    // The legacy runtime still lists its known catalog projects; the runtime
    // readiness is communicated by canCreate/bridgeCreate, not by hiding them.
    assert.deepEqual(host.projects.map((project) => project.id).sort(), [f.projects[2].id, extra.id].sort())
    for (const project of host.projects) assert.equal(project.canCreate, false)
    assert.equal(remote.creates, 0)
    // An attempted create fails with a clear error and zero session POSTs.
    await assert.rejects(service.createTerminal(client, f.hosts[2].id, f.projects[2].id, 'claude', randomUUID()), /no soporta/)
    assert.equal(remote.creates, 0)
    // No prepared intent leaks into the registry after the failed attempt.
    assert.equal(new BridgeRegistry(f.dir).snapshot().creations.length, 0)
    // With support back, context reports every project as creatable again.
    remote.legacyHealth = false
    const healthy = await service.context(client)
    const healthyHost = healthy.hosts.find((item) => item.id === f.hosts[2].id)
    assert.equal(healthyHost.bridgeCreate, true)
    for (const project of healthyHost.projects) assert.equal(project.canCreate, true)
  } finally { f.cleanup() }
})

test('creation rejects offline hosts, changed identities and changed project roots', async () => {
  const f = fixture()
  try {
    const service = f.service(), remote = f.remotes[2]
    remote.availability = 'disconnected'
    await assert.rejects(service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', randomUUID()), /identidad actual/)
    assert.equal(remote.creates, 0)
    remote.availability = 'connected'
    remote.identity = { role: 'member', id: 'actor-a' }
    const key = randomUUID()
    assert.ok((await service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', key)).sessionId)
    // Another Crow identity must not reuse the prepared creation.
    remote.identity = { role: 'member', id: 'actor-b' }
    await assert.rejects(f.service().createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', key), /identidad Crow/)
    // Changing the saved project root invalidates the retry instead of creating elsewhere.
    remote.identity = { role: 'member', id: 'actor-a' }
    f.workspace.saveProject({ ...f.projects[2], root: '/changed-test-2' })
    await assert.rejects(f.service().createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', key), /Conflicto de idempotencia/)
    assert.equal(remote.creates, 1)
  } finally { f.cleanup() }
})

test('a runtime returning a different agent than the requested one is rejected', async () => {
  const f = fixture()
  try {
    const remote = f.remotes[2], original = remote.api.bind(remote)
    remote.api = async (...args) => {
      const value = await original(...args)
      // A runtime that spawned a different agent reports it both in the
      // creation response and in the session list: neither may contradict
      // the agent anchored in the durable record.
      if (args[0] === 'POST') return { ...value, agent: 'claude' } // Different from requested codex
      if (args[0] === 'GET' && args[1] === '/api/sessions') return value.map((item) => ({ ...item, agent: 'claude' }))
      return value
    }
    const key = randomUUID()
    await assert.rejects(f.service().createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'codex', key), /no se pudo verificar/)
    assert.equal(f.remotes[2].creates, 1)
    // A retry with the same key cannot bypass verification by replay.
    await assert.rejects(f.service().createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'codex', key), /no se pudo verificar/)
    assert.equal(f.remotes[2].creates, 1)
  } finally { f.cleanup() }
})

test('creation idempotency survives lost responses, restart and concurrent retries', async () => {
  const f = fixture()
  try {
    let service = f.service()
    const remote = f.remotes[2], original = remote.api.bind(remote)
    remote.api = async (...args) => {
      const response = await original(...args)
      if (args[0] === 'POST') throw new Error('secret-network-error-marker')
      return response
    }
    const key = randomUUID()
    await assert.rejects(service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', key))
    assert.equal(remote.creates, 1)
    // A restarted Crow MCP retries the durable key instead of spawning a second terminal.
    service = f.service()
    remote.api = original
    const recovered = await service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', key)
    assert.equal(remote.creates, 1)
    assert.ok(recovered.sessionId)
    // Same key with a different payload conflicts, it never creates a new terminal.
    await assert.rejects(service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'codex', key), /Conflicto de idempotencia/)
    // Concurrent duplicate retries share one terminal and one server key.
    // Each parallel caller re-proves bridgeCreateVersion via /api/health, but
    // the session POST itself stays deduplicated to one.
    const concurrent = randomUUID()
    const [a, b] = await Promise.all([
      service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', concurrent),
      service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', concurrent)
    ])
    assert.equal(a.sessionId, b.sessionId)
    assert.equal(remote.creates, 2)
    const persisted = readFileSync(join(f.dir, 'bridge.json'), 'utf8')
    for (const marker of [...f.tokens, 'private-key-marker', 'secret-network-error-marker']) assert.ok(!persisted.includes(marker))
  } finally { f.cleanup() }
})
