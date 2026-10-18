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
  const tokens = [0, 1, 2, 3].map(() => randomBytes(32).toString('base64url'))
  const sessions = [0, 1].map((index) => ({ id: String(index + 1).repeat(32), root: projects[index].root, agent: 'claude', mode: 'normal', hooksActive: true, state: 'running', agentState: 'waiting', seq: 0 }))
  const hash = (token) => createHash('sha256').update(token).digest('hex')
  const clients = [
    { id: 'client-0', tokenSha256: hash(tokens[0]), grants: [{ hostId: hosts[0].id, projectId: projects[0].id, sessionId: sessions[0].id, operations: ['discover', 'register', 'hello', 'result', 'rename', 'chat'] }] },
    { id: 'client-1', tokenSha256: hash(tokens[1]), grants: [{ hostId: hosts[1].id, projectId: projects[1].id, sessionId: sessions[1].id, operations: ['discover', 'register', 'hello', 'result'] }] },
    // Authenticated create-only client: no terminal grants and no project grant.
    { id: 'client-create', tokenSha256: hash(tokens[2]), grants: [] },
    // Owner opted this client into bypass creation.
    { id: 'client-bypass', tokenSha256: hash(tokens[3]), grants: [], allowBypass: true }
  ]
  // Synthetic runtime boundary: never opens SSH, a shell, files or a real agent.
  const remotes = hosts.map((_, index) => {
    const sessionList = index < sessions.length ? [sessions[index]] : []
    // Synthetic durable chat ledger. `submits` mirrors the remote
    // chat-submit-operations ledger keyed by requestId; each record carries the
    // authoritative baseline and user-hook sequence. `legacyDto` simulates a
    // remote that never exposed sequences, and `statusFailure` a status-query
    // network failure.
    const chat = {
      messages: [], submits: new Map(), submitsSeen: 0, statusCalls: 0, historyCalls: 0,
      status: undefined, statusFailure: false, legacyDto: false,
      dto(record) {
        const base = { operationId: record.requestId, requestId: record.requestId, sessionId: record.sessionId, status: record.status }
        if (this.legacyDto) return base
        // The authoritative user-hook sequence is only exposed once the hook has
        // confirmed the submission (`accepted`); earlier or terminal states carry
        // no sequence, mirroring the client's fail-closed identity/correlation
        // contract.
        return { ...base, baselineSeq: record.baseline, userSeq: record.status === 'accepted' ? record.userSeq : 0 }
      }
    }
    return {
      availability: 'connected', sends: 0, creates: 0, tasks: new Map(), creations: new Map(), mismatch: false,
      legacyHealth: false,
      // A new capability is advertised separately so bypass can be disabled
      // independently of normal creation (older runtime simulation).
      bypassCapability: true,
      // The live session objects, so tests can mutate presence/state/read-only
      // exactly as the remote would report them through GET /api/sessions.
      sessionList,
      chat,
      status() { return this.availability },
      async api(method, path, body) {
        if (this.availability !== 'connected') throw new Error('secret-network-error-marker')
        if (path === '/api/access/me') return this.identity || { role: 'legacy' }
        if (path === '/api/health') return { bridgeHelloVersion: 1, bridgeCreateVersion: this.legacyHealth ? 0 : 1, bridgeCreateBypassVersion: this.legacyHealth || !this.bypassCapability ? 0 : 1 }
        if (path === '/api/sessions' && method === 'GET') return sessionList.map((item) => structuredClone(item))
        if (path === '/api/sessions' && method === 'POST') {
          assert.ok(body.mode === 'normal' || body.mode === 'bypass')
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
        // Structured chat: mirrors the audited remote chat/submit + history API.
        const chatMatch = /^\/api\/sessions\/([0-9a-f]{32})\/chat(\/submit)?(\?.*)?$/.exec(path)
        if (chatMatch) {
          const sessionId = chatMatch[1]
          const query = Object.fromEntries(new URLSearchParams(chatMatch[3]?.slice(1) || ''))
          if (chatMatch[2] === '/submit' && method === 'POST') {
            if (this.chat.submits.has(body.requestId)) {
              const prior = this.chat.submits.get(body.requestId)
              if (prior.sessionId !== sessionId || prior.text !== body.text) throw new Error('secret-chat-conflict')
              return this.chat.dto(prior)
            }
            this.chat.submitsSeen++
            // The remote reserves the submission and the hook later appends the
            // user message; the synthetic ledger records both boundaries at once.
            const baseline = this.chat.messages.length ? this.chat.messages.at(-1).seq : 0
            const userSeq = baseline + 1
            this.chat.messages.push({ role: 'user', content: body.text, seq: userSeq })
            const record = { requestId: body.requestId, sessionId, text: body.text, baseline, userSeq, status: this.chat.status || 'accepted' }
            this.chat.submits.set(body.requestId, record)
            return this.chat.dto(record)
          }
          if (chatMatch[2] === '/submit' && method === 'GET') {
            this.chat.statusCalls++
            if (this.chat.statusFailure) throw new Error('secret-network-error-marker')
            const record = this.chat.submits.get(query.requestId)
            if (!record) return { operationId: query.requestId, requestId: query.requestId, sessionId, status: 'unknown', baselineSeq: 0, userSeq: 0 }
            return this.chat.dto(record)
          }
          if (chatMatch[2] === undefined && method === 'GET') {
            const after = Number(query.after || 0)
            const limit = Number(query.limit || 50)
            this.chat.historyCalls++
            const filtered = this.chat.messages.filter((message) => message.seq > after)
            if (query.after) return { messages: filtered.slice(0, limit), hasMore: false, nextBefore: 0 }
            return { messages: filtered.slice(-limit), hasMore: false, nextBefore: filtered[0]?.seq || 0 }
          }
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
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['crow_context', 'crow_create_terminal', 'crow_get_message_result', 'crow_get_result', 'crow_register_orchestrator', 'crow_rename_terminal', 'crow_send_hello', 'crow_send_message'])
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

test('crow_rename_terminal updates the Crow alias with client/grant authorization and idempotency', async () => {
  const f = fixture()
  const policy = { version: 1, port: await freePort(), clients: f.clients }
  const gateway = new BridgeGateway(policy, f.service())
  let client, creator
  try {
    const url = await gateway.start()
    client = await connect(url, f.tokens[0], 'rename-grant-client')
    creator = await connect(url, f.tokens[2], 'rename-created-client')
    const schema = (await client.listTools()).tools.find((tool) => tool.name === 'crow_rename_terminal').inputSchema
    assert.deepEqual([...schema.required].sort(), ['hostId', 'name', 'projectId', 'requestId', 'sessionId'])
    // Grant path: client-0 holds the rename operation on sessions[0].
    const requestId = randomUUID()
    const renamed = await call(client, 'crow_rename_terminal', { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, name: '  QA limpio  ', requestId })
    assert.equal(renamed.name, 'QA limpio')
    assert.equal(renamed.via, 'grant')
    assert.equal(f.workspace.sessionName(f.hosts[0].id, f.sessions[0].id), 'QA limpio')
    const replay = await call(client, 'crow_rename_terminal', { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, name: 'QA limpio', requestId })
    // A later context reads the persisted alias from the same store, not the
    // fallback label, so the owner's Crow name is what callers see.
    const renamedContext = await call(client, 'crow_context')
    const renamedTerminal = renamedContext.hosts.find((host) => host.id === f.hosts[0].id).projects.find((project) => project.id === f.projects[0].id).terminals.find((terminal) => terminal.sessionId === f.sessions[0].id)
    assert.equal(renamedTerminal.name, 'QA limpio')
    assert.equal(replay.appliedAt, renamed.appliedAt)
    // Same request id with a changed name or target is a conflict before writing.
    assert.ok((await client.callTool({ name: 'crow_rename_terminal', arguments: { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, name: 'Otro', requestId } })).isError)
    assert.ok((await client.callTool({ name: 'crow_rename_terminal', arguments: { hostId: f.hosts[1].id, projectId: f.projects[1].id, sessionId: f.sessions[1].id, name: 'QA limpio', requestId } })).isError)
    // Empty, over-long, control and ANSI names are rejected before any write.
    for (const name of ['', '   ', 'x'.repeat(49), 'bad\u001bname', 'esc\u009bseq', 'line\nbreak']) {
      assert.ok((await client.callTool({ name: 'crow_rename_terminal', arguments: { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, name, requestId: randomUUID() } })).isError)
    }
    // A client with neither grant nor creation cannot rename someone else's terminal.
    assert.ok((await creator.callTool({ name: 'crow_rename_terminal', arguments: { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, name: 'Robado', requestId: randomUUID() } })).isError)
    assert.equal(f.workspace.sessionName(f.hosts[0].id, f.sessions[0].id), 'QA limpio')
    // Creator path: the client that created a terminal may rename it.
    const created = await call(creator, 'crow_create_terminal', { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey: randomUUID() })
    const createdRename = await call(creator, 'crow_rename_terminal', { hostId: f.hosts[2].id, projectId: f.projects[2].id, sessionId: created.sessionId, name: 'Creada por MCP', requestId: randomUUID() })
    assert.equal(createdRename.via, 'created')
    assert.equal(f.workspace.sessionName(f.hosts[2].id, created.sessionId), 'Creada por MCP')
    // No other client can reach the created terminal.
    assert.ok((await client.callTool({ name: 'crow_rename_terminal', arguments: { hostId: f.hosts[2].id, projectId: f.projects[2].id, sessionId: created.sessionId, name: 'Ajena', requestId: randomUUID() } })).isError)
    assert.equal(f.workspace.sessionName(f.hosts[2].id, created.sessionId), 'Creada por MCP')
  } finally { await client?.close(); await creator?.close(); await gateway.stop(); f.cleanup() }
})

test('crow_send_message and crow_get_message_result submit, dedupe, correlate and fail closed', async () => {
  const f = fixture()
  const policy = { version: 1, port: await freePort(), clients: f.clients }
  const gateway = new BridgeGateway(policy, f.service())
  let client
  try {
    const url = await gateway.start()
    client = await connect(url, f.tokens[0], 'chat-grant-client')
    const schema = (await client.listTools()).tools.find((tool) => tool.name === 'crow_send_message').inputSchema
    assert.deepEqual([...schema.required].sort(), ['hostId', 'projectId', 'requestId', 'sessionId', 'text'])
    const requestId = randomUUID()
    const send = await call(client, 'crow_send_message', { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, text: 'hola\nmundo', requestId })
    assert.equal(send.delivery, 'accepted')
    assert.equal(send.state, 'pending')
    assert.equal(f.remotes[0].chat.submitsSeen, 1)
    // A repeated request is reconciled with the durable ledger, never re-POSTed.
    const replay = await call(client, 'crow_send_message', { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, text: 'hola\nmundo', requestId })
    assert.equal(replay.requestId, requestId)
    assert.equal(replay.delivery, 'accepted')
    assert.equal(f.remotes[0].chat.submitsSeen, 1)
    assert.equal(f.remotes[0].chat.statusCalls, 1)
    // Same id with changed text or target is a conflict before sending.
    assert.ok((await client.callTool({ name: 'crow_send_message', arguments: { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, text: 'otro', requestId } })).isError)
    assert.ok((await client.callTool({ name: 'crow_send_message', arguments: { hostId: f.hosts[1].id, projectId: f.projects[1].id, sessionId: f.sessions[1].id, text: 'hola\nmundo', requestId } })).isError)
    assert.equal(f.remotes[0].chat.submitsSeen, 1)
    // Acceptance/write is never reported as completion.
    const pending = await call(client, 'crow_get_message_result', { requestId })
    assert.equal(pending.state, 'pending')
    assert.equal(pending.response, undefined)
    assert.equal(pending.correlation, 'unavailable')
    // Only the assistant reply after the authoritative user sequence completes
    // the request, sanitized.
    f.remotes[0].chat.messages.push({ role: 'assistant', content: 'respuesta\u0007limpia', seq: f.remotes[0].chat.messages.length + 1 })
    const completed = await call(client, 'crow_get_message_result', { requestId })
    assert.equal(completed.state, 'completed')
    assert.equal(completed.correlation, 'assistant-after-user-sequence')
    assert.equal(completed.response, 'respuesta limpia')
    // Malformed text is rejected before any submit; the ledger is untouched.
    for (const text of ['', '   ', 'bad\u001btext', 'bell\u0007', 'long'.repeat(2000)]) {
      assert.ok((await client.callTool({ name: 'crow_send_message', arguments: { hostId: f.hosts[0].id, projectId: f.projects[0].id, sessionId: f.sessions[0].id, text, requestId: randomUUID() } })).isError)
    }
    assert.equal(f.remotes[0].chat.submitsSeen, 1)
    // A client with neither chat grant nor creation cannot message another terminal.
    assert.ok((await client.callTool({ name: 'crow_send_message', arguments: { hostId: f.hosts[1].id, projectId: f.projects[1].id, sessionId: f.sessions[1].id, text: 'intruso', requestId: randomUUID() } })).isError)
  } finally { await client?.close(); await gateway.stop(); f.cleanup() }
})

test('an uncertain chat submission is reconciled from the durable ledger without a second POST', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0], original = remote.api.bind(remote)
    const requestId = randomUUID()
    // The remote records the submission but the response is lost.
    remote.api = async (...args) => { const value = await original(...args); if (args[0] === 'POST') throw new Error('secret-network-error-marker'); return value }
    const uncertain = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'entrega incierta', requestId)
    assert.equal(uncertain.state, 'uncertain')
    assert.equal(remote.chat.submitsSeen, 1)
    // Restart + retry reconciles the known delivery from the ledger: no resend.
    remote.api = original
    const reconciled = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'entrega incierta', requestId)
    assert.equal(reconciled.delivery, 'accepted')
    assert.equal(reconciled.state, 'pending')
    assert.equal(remote.chat.submitsSeen, 1)
    // A changed payload with the same id is a conflict before sending.
    await assert.rejects(f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'otro texto', requestId), /Conflicto de idempotencia/)
    assert.equal(remote.chat.submitsSeen, 1)
  } finally { f.cleanup() }
})

test('a chat record prepared locally before the POST is reconciled and re-sent only when the ledger reports unknown', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0]
    const requestId = randomUUID()
    const prompt = 'preparado sin enviar'
    // A crash after the durable local intent but before any POST: the record is
    // pending and the remote ledger has never seen this requestId.
    const seed = new BridgeRegistry(f.dir)
    seed.prepareMessage({ requestId, clientId: client.id, hostId: f.hosts[0].id, hostRevision: 'a'.repeat(64), projectId: f.projects[0].id,
      sessionId: f.sessions[0].id, root: f.projects[0].root, textHash: createHash('sha256').update(prompt, 'utf8').digest('hex'),
      textLength: Buffer.byteLength(prompt, 'utf8'), baselineSeq: 0, via: 'grant', delivery: 'pending', state: 'pending', correlation: 'unavailable', createdAt: new Date().toISOString() })
    const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, prompt, requestId)
    assert.equal(sent.delivery, 'accepted')
    assert.equal(sent.state, 'pending')
    assert.equal(remote.chat.submitsSeen, 1)
    assert.equal(remote.chat.statusCalls, 1)
  } finally { f.cleanup() }
})

test('known rejected, written and accepted ledger states update delivery without another POST', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0]
    for (const status of ['rejected', 'written', 'accepted']) {
      const requestId = randomUUID()
      const prompt = `estado ${status}`
      const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, prompt, requestId)
      assert.equal(sent.delivery, 'accepted')
      const before = remote.chat.submitsSeen
      // The remote ledger evolves; a retry reads the new state, never re-POSTs.
      remote.chat.submits.get(requestId).status = status
      const reconciled = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, prompt, requestId)
      assert.equal(reconciled.delivery, status)
      assert.equal(reconciled.state, status === 'rejected' ? 'rejected' : 'pending')
      assert.equal(remote.chat.submitsSeen, before)
    }
  } finally { f.cleanup() }
})

test('a status-query network failure never re-sends and keeps the local record', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0]
    const requestId = randomUUID()
    const prompt = 'consulta caida'
    const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, prompt, requestId)
    assert.equal(sent.delivery, 'accepted')
    const before = remote.chat.submitsSeen
    remote.chat.statusFailure = true
    const held = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, prompt, requestId)
    assert.equal(held.delivery, 'accepted')
    assert.equal(held.requestId, requestId)
    assert.equal(remote.chat.submitsSeen, before)
    remote.chat.statusFailure = false
    // A malformed status is fail-closed the same way: no resend, no downgrade.
    remote.chat.submits.set(requestId, { ...remote.chat.submits.get(requestId), status: 'not-a-status' })
    const malformed = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, prompt, requestId)
    assert.equal(malformed.delivery, 'accepted')
    assert.equal(remote.chat.submitsSeen, before)
  } finally { f.cleanup() }
})

test('chat correlation uses the authoritative hook sequence, not prompt text, so duplicate text cannot attach an unrelated reply', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0]
    const requestId = randomUUID()
    const prompt = 'misma instruccion'
    // Another surface submitted the identical text first and already has a reply.
    remote.chat.messages.push({ role: 'user', content: prompt, seq: 1 })
    remote.chat.messages.push({ role: 'assistant', content: 'respuesta ajena', seq: 2 })
    // Our POST landed later and was hook-confirmed at seq 3, with its own reply.
    remote.chat.submits.set(requestId, { requestId, sessionId: f.sessions[0].id, text: prompt, baseline: 2, userSeq: 3, status: 'accepted' })
    remote.chat.messages.push({ role: 'user', content: prompt, seq: 3 })
    remote.chat.messages.push({ role: 'assistant', content: 'respuesta propia', seq: 4 })
    // A stale local baseline of 0 would have matched the first user turn (seq 1).
    const seed = new BridgeRegistry(f.dir)
    seed.prepareMessage({ requestId, clientId: client.id, hostId: f.hosts[0].id, hostRevision: 'a'.repeat(64), projectId: f.projects[0].id,
      sessionId: f.sessions[0].id, root: f.projects[0].root, textHash: createHash('sha256').update(prompt, 'utf8').digest('hex'),
      textLength: Buffer.byteLength(prompt, 'utf8'), baselineSeq: 0, via: 'grant', delivery: 'pending', state: 'pending', correlation: 'unavailable', createdAt: new Date().toISOString() })
    const service = f.service()
    const reconciled = await service.sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, prompt, requestId)
    assert.equal(reconciled.delivery, 'accepted')
    assert.equal(remote.chat.submitsSeen, 0)
    const result = await service.messageResult(client, requestId)
    assert.equal(result.state, 'completed')
    assert.equal(result.correlation, 'assistant-after-user-sequence')
    assert.equal(result.response, 'respuesta propia')
    assert.equal(result.responseSeq, 4)
  } finally { f.cleanup() }
})

test('chat correlation fails closed when the remote omits the sequence or the status', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0]
    // A legacy remote: delivery is known but the authoritative sequence is absent.
    remote.chat.legacyDto = true
    const requestId = randomUUID()
    const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'sin secuencia', requestId)
    assert.equal(sent.delivery, 'accepted')
    remote.chat.messages.push({ role: 'assistant', content: 'no correlacionable', seq: remote.chat.messages.length + 1 })
    const noSequence = await f.service().messageResult(client, requestId)
    assert.equal(noSequence.correlation, 'unavailable')
    assert.equal(noSequence.response, undefined)
    // A missing status is also fail-closed, and a retry never re-sends.
    remote.chat.legacyDto = false
    const otherId = randomUUID()
    await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'sin estado', otherId)
    const before = remote.chat.submitsSeen
    remote.chat.submits.set(otherId, { ...remote.chat.submits.get(otherId), status: undefined })
    const missing = await f.service().messageResult(client, otherId)
    assert.equal(missing.correlation, 'unavailable')
    const retried = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'sin estado', otherId)
    assert.equal(retried.correlation, 'unavailable')
    assert.equal(remote.chat.submitsSeen, before)
  } finally { f.cleanup() }
})

test('a chat status DTO must name the exact request and session for a POST to be trusted', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0], original = remote.api.bind(remote)
    for (const field of ['requestId', 'sessionId']) {
      // The remote answers the POST with a DTO for a different operation/session.
      remote.api = async (method, path, body) => {
        const value = await original(method, path, body)
        if (method === 'POST' && /\/chat\/submit$/.test(path)) return { ...value, [field]: field === 'requestId' ? randomUUID() : 'f'.repeat(32) }
        return value
      }
      const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, `identidad ${field}`, randomUUID())
      // A mismatched identity is ambiguous: never a false acceptance or correlation.
      assert.equal(sent.delivery, 'uncertain')
      assert.equal(sent.state, 'uncertain')
      assert.equal(sent.correlation, 'unavailable')
    }
    // The ledger recorded both submissions; only an honest DTO accepts, still without resend.
    remote.api = original
    const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'identidad honesta', randomUUID())
    assert.equal(sent.delivery, 'accepted')
    assert.equal(remote.chat.submitsSeen, 3)
  } finally { f.cleanup() }
})

test('a malformed retry status never re-sends and preserves the prior local delivery', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0], original = remote.api.bind(remote)
    const requestId = randomUUID()
    const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'reintento ajeno', requestId)
    assert.equal(sent.delivery, 'accepted')
    const before = remote.chat.submitsSeen
    const poison = (transform) => {
      remote.api = async (method, path, body) => {
        const value = await original(method, path, body)
        if (method === 'GET' && /\/chat\/submit\?/.test(path)) return transform(value)
        return value
      }
    }
    for (const transform of [
      (value) => ({ ...value, requestId: randomUUID() }),   // another operation
      (value) => ({ ...value, sessionId: 'f'.repeat(32) }), // another session
      (value) => ({ ...value, status: 'written' }),         // hook sequence with a non-accepted status
      (value) => ({ ...value, baselineSeq: value.userSeq }), // not strictly greater than the baseline
      (value) => ({ ...value, userSeq: 'uno' })             // wrong type
    ]) {
      poison(transform)
      const held = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'reintento ajeno', requestId)
      assert.equal(held.delivery, 'accepted')
      assert.equal(held.state, 'pending')
      assert.equal(remote.chat.submitsSeen, before)
    }
    // An honest status still reconciles from the ledger, and still without a resend.
    remote.api = original
    const okay = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'reintento ajeno', requestId)
    assert.equal(okay.delivery, 'accepted')
    assert.equal(remote.chat.submitsSeen, before)
  } finally { f.cleanup() }
})

test('a POST status with a mistyped, negative, unsafe or unconfirmed sequence is ambiguous, never an acceptance', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0], original = remote.api.bind(remote)
    const poison = (transform) => {
      remote.api = async (method, path, body) => {
        const value = await original(method, path, body)
        if (method === 'POST' && /\/chat\/submit$/.test(path)) return transform(value)
        return value
      }
    }
    for (const transform of [
      (value) => ({ ...value, baselineSeq: -1 }),
      (value) => ({ ...value, userSeq: 'uno' }),
      (value) => ({ ...value, userSeq: -1 }),
      (value) => ({ ...value, userSeq: 1.5 }),
      (value) => ({ ...value, userSeq: Number.MAX_SAFE_INTEGER + 1 }),
      (value) => { const { baselineSeq: _baseline, ...rest } = value; return { ...rest, userSeq: 2 } }, // sequence without a baseline
      (value) => ({ ...value, baselineSeq: value.userSeq }), // not strictly greater
      (value) => ({ ...value, status: 'written' })           // hook sequence with a non-accepted status
    ]) {
      poison(transform)
      const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'secuencia inválida', randomUUID())
      assert.equal(sent.delivery, 'uncertain')
      assert.equal(sent.state, 'uncertain')
      assert.equal(sent.correlation, 'unavailable')
    }
    remote.api = original
    const sent = await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'secuencia válida', randomUUID())
    assert.equal(sent.delivery, 'accepted')
  } finally { f.cleanup() }
})

test('a result status with a mismatched identity or unconfirmed sequence fails closed without leaking a reply', async () => {
  const f = fixture()
  try {
    const client = f.clients[0], remote = f.remotes[0], original = remote.api.bind(remote)
    const requestId = randomUUID()
    await f.service().sendMessage(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'correlación estricta', requestId)
    // A reply exists and would be returned by a permissive correlation.
    const record = remote.chat.submits.get(requestId)
    remote.chat.messages.push({ role: 'assistant', content: 'respuesta que no debe filtrarse', seq: record.userSeq + 1 })
    const poison = (transform) => {
      remote.api = async (method, path, body) => {
        const value = await original(method, path, body)
        if (method === 'GET' && /\/chat\/submit\?/.test(path)) return transform(value)
        return value
      }
    }
    for (const transform of [
      (value) => ({ ...value, requestId: randomUUID() }),  // another operation
      (value) => ({ ...value, sessionId: 'f'.repeat(32) }), // another session
      (value) => ({ ...value, userSeq: value.baselineSeq }), // no hook sequence (0) -> no correlation
      (value) => ({ ...value, status: 'written' }),         // hook sequence with a non-accepted status
      (value) => ({ ...value, baselineSeq: value.userSeq }), // not strictly greater
      (value) => { const { baselineSeq: _baseline, ...rest } = value; return { ...rest, userSeq: 2 } }, // sequence without a baseline
      (value) => ({ ...value, userSeq: 'uno' })             // wrong type
    ]) {
      poison(transform)
      const result = await f.service().messageResult(client, requestId)
      assert.equal(result.state, 'pending')
      assert.equal(result.correlation, 'unavailable')
      assert.equal(result.response, undefined)
    }
    assert.equal(remote.chat.submitsSeen, 1)
  } finally { f.cleanup() }
})

test('rename and chat fail closed when the Crow identity changes during the operation', async () => {
  const f = fixture()
  try {
    const remote = f.remotes[0], original = remote.api.bind(remote)
    remote.identity = { role: 'member', id: 'actor-a' }
    remote.api = async (...args) => { const value = await original(...args); remote.identity = { role: 'member', id: 'actor-b' }; return value }
    await assert.rejects(f.service().renameTerminal(f.clients[0], f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'cambia', randomUUID()), /identidad Crow/)
    assert.equal(f.workspace.sessionName(f.hosts[0].id, f.sessions[0].id), undefined)
  } finally { f.cleanup() }
})

test('crow_create_terminal bypass requires confirmBypass, owner policy, capability and idempotent mode', async () => {
  const f = fixture()
  const policy = { version: 1, port: await freePort(), clients: f.clients }
  const gateway = new BridgeGateway(policy, f.service())
  let client, bypass
  try {
    const url = await gateway.start()
    client = await connect(url, f.tokens[2], 'create-normal-client')
    bypass = await connect(url, f.tokens[3], 'create-bypass-client')
    // Bypass needs both the explicit per-call confirmation and the owner policy.
    assert.ok((await client.callTool({ name: 'crow_create_terminal', arguments: { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey: randomUUID(), mode: 'bypass', confirmBypass: true } })).isError)
    assert.ok((await bypass.callTool({ name: 'crow_create_terminal', arguments: { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey: randomUUID(), mode: 'bypass' } })).isError)
    assert.equal(f.remotes[2].creates, 0)
    // A runtime without the separate bypass capability receives zero bypass POSTs.
    f.remotes[2].bypassCapability = false
    assert.ok((await bypass.callTool({ name: 'crow_create_terminal', arguments: { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey: randomUUID(), mode: 'bypass', confirmBypass: true } })).isError)
    assert.equal(f.remotes[2].creates, 0)
    f.remotes[2].bypassCapability = true
    const requestKey = randomUUID()
    const created = await call(bypass, 'crow_create_terminal', { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey, mode: 'bypass', confirmBypass: true })
    assert.equal(created.mode, 'bypass')
    assert.equal(f.remotes[2].creates, 1)
    const retried = await call(bypass, 'crow_create_terminal', { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey, mode: 'bypass', confirmBypass: true })
    assert.equal(retried.sessionId, created.sessionId)
    assert.equal(f.remotes[2].creates, 1)
    // The same key with a different mode conflicts instead of reusing the terminal.
    assert.ok((await bypass.callTool({ name: 'crow_create_terminal', arguments: { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'claude', requestKey, mode: 'normal' } })).isError)
    assert.equal(f.remotes[2].creates, 1)
    // Normal stays the default and needs no bypass opt-in.
    const normal = await call(client, 'crow_create_terminal', { hostId: f.hosts[2].id, projectId: f.projects[2].id, agent: 'codex', requestKey: randomUUID() })
    assert.equal(normal.mode, 'normal')
    const context = await call(bypass, 'crow_context')
    const host = context.hosts.find((item) => item.id === f.hosts[2].id)
    assert.equal(host.bridgeCreateBypass, true)
    assert.equal(context.capabilities.createBypass, true)
    const project = host.projects.find((item) => item.id === f.projects[2].id)
    assert.equal(project.canCreateBypass, true)
    assert.equal(project.terminals.find((terminal) => terminal.sessionId === created.sessionId).mode, 'bypass')
    const normalContext = await call(client, 'crow_context')
    assert.equal(normalContext.capabilities.createBypass, false)
    assert.equal(normalContext.hosts.find((item) => item.id === f.hosts[2].id).bridgeCreateBypass, false)
    // Legacy default: an old policy file parses with allowBypass false.
    assert.equal(policySchema.parse({ version: 1, port: 47600, clients: [f.clients[2]] }).clients[0].allowBypass, false)
  } finally { await client?.close(); await bypass?.close(); await gateway.stop(); f.cleanup() }
})

test('legacy runtime without creation support keeps normal at version 1 and refuses bypass with zero POSTs', async () => {
  const f = fixture()
  try {
    const remote = f.remotes[2], service = f.service(), bypassClient = f.clients[3]
    remote.legacyHealth = true
    await assert.rejects(service.createTerminal(bypassClient, f.hosts[2].id, f.projects[2].id, 'claude', randomUUID(), 'bypass', true), /no soporta/)
    assert.equal(remote.creates, 0)
    remote.legacyHealth = false
    const normal = await service.createTerminal(f.clients[2], f.hosts[2].id, f.projects[2].id, 'claude', randomUUID())
    assert.equal(normal.mode, 'normal')
    assert.equal(remote.creates, 1)
  } finally { f.cleanup() }
})

test('crow_context reports effective chat eligibility per terminal instead of assuming every created terminal allows chat', async () => {
  const f = fixture()
  try {
    const client = f.clients[0]
    const granted = (context) => context.hosts.find((host) => host.id === f.hosts[0].id).projects.find((project) => project.id === f.projects[0].id).terminals.find((terminal) => terminal.sessionId === f.sessions[0].id)
    // A grant listing `chat` is not enough: a hook-less terminal is not chattable.
    f.sessions[0].hooksActive = false
    const noHooks = granted(await f.service().context(client))
    assert.equal(noHooks.canChat, false)
    assert.ok(!noHooks.allowedOperations.includes('chat'))
    assert.ok(noHooks.allowedOperations.includes('discover'))
    // A stopped terminal is not chattable either.
    f.sessions[0].hooksActive = true
    f.sessions[0].state = 'exited'
    const stopped = granted(await f.service().context(client))
    assert.equal(stopped.canChat, false)
    assert.ok(!stopped.allowedOperations.includes('chat'))
    f.sessions[0].state = 'running'
    const eligible = granted(await f.service().context(client))
    assert.equal(eligible.canChat, true)
    assert.ok(eligible.allowedOperations.includes('chat'))
    // A bypass terminal WITH active hooks IS chattable and can round-trip chat
    // through the audited endpoint, authorized by its own durable creation.
    const created = await f.service().createTerminal(f.clients[3], f.hosts[2].id, f.projects[2].id, 'claude', randomUUID(), 'bypass', true)
    assert.equal(created.mode, 'bypass')
    const createdTerminal = (context) => context.hosts.find((host) => host.id === f.hosts[2].id).projects.find((project) => project.id === f.projects[2].id).terminals.find((terminal) => terminal.sessionId === created.sessionId)
    const bypassTerminal = createdTerminal(await f.service().context(f.clients[3]))
    assert.equal(bypassTerminal.canChat, true)
    assert.ok(bypassTerminal.allowedOperations.includes('chat'))
    assert.ok(bypassTerminal.allowedOperations.includes('rename'))
    assert.equal(bypassTerminal.mode, 'bypass')
    const chatId = randomUUID()
    const bypassSent = await f.service().sendMessage(f.clients[3], f.hosts[2].id, f.projects[2].id, created.sessionId, 'hola bypass', chatId)
    assert.equal(bypassSent.delivery, 'accepted')
    assert.equal(bypassSent.via, 'created')
    assert.equal(f.remotes[2].chat.submitsSeen, 1)
    // Only the assistant reply after the authoritative user hook sequence completes it.
    f.remotes[2].chat.messages.push({ role: 'assistant', content: 'respuesta bypass', seq: f.remotes[2].chat.messages.length + 1 })
    const bypassDone = await f.service().messageResult(f.clients[3], chatId)
    assert.equal(bypassDone.state, 'completed')
    assert.equal(bypassDone.correlation, 'assistant-after-user-sequence')
    assert.equal(bypassDone.response, 'respuesta bypass')
    // Negative bypass cases: without hooks, read-only, stopped, unsupported
    // agent or missing, chat stays hidden and sending still fails closed.
    const createdSession = f.remotes[2].sessionList.find((item) => item.id === created.sessionId)
    for (const mutate of [
      () => { createdSession.hooksActive = false },
      () => { createdSession.hooksActive = true; createdSession.readOnly = true },
      () => { createdSession.readOnly = false; createdSession.state = 'exited' },
      () => { createdSession.state = 'running'; createdSession.agent = 'shell' },
      () => { f.remotes[2].sessionList.splice(0) }
    ]) {
      mutate()
      const terminal = createdTerminal(await f.service().context(f.clients[3]))
      assert.equal(terminal.canChat, false)
      assert.ok(!terminal.allowedOperations.includes('chat'))
      assert.ok(terminal.allowedOperations.includes('rename'))
      await assert.rejects(f.service().sendMessage(f.clients[3], f.hosts[2].id, f.projects[2].id, created.sessionId, 'no elegible', randomUUID()))
    }
    assert.equal(f.remotes[2].chat.submitsSeen, 1)
  } finally { f.cleanup() }
})

test('crow_context hides chat on sleeping or non-idle agent sessions in both normal and bypass modes', async () => {
  const f = fixture()
  try {
    // Bypass terminal authorized only by its own durable creation, so the
    // created (no-grant) path is exercised alongside the normal grant path.
    const created = await f.service().createTerminal(f.clients[3], f.hosts[2].id, f.projects[2].id, 'claude', randomUUID(), 'bypass', true)
    const createdSession = f.remotes[2].sessionList.find((item) => item.id === created.sessionId)
    const readNormal = async () => (await f.service().context(f.clients[0])).hosts.find((host) => host.id === f.hosts[0].id).projects.find((project) => project.id === f.projects[0].id).terminals.find((terminal) => terminal.sessionId === f.sessions[0].id)
    const readBypass = async () => (await f.service().context(f.clients[3])).hosts.find((host) => host.id === f.hosts[2].id).projects.find((project) => project.id === f.projects[2].id).terminals.find((terminal) => terminal.sessionId === created.sessionId)
    // Both are eligible while running and idle, so each negative case below
    // proves its own guard rather than a leftover mutation from the other mode.
    assert.equal((await readNormal()).canChat, true)
    assert.equal((await readBypass()).canChat, true)
    for (const [mode, session, read] of [['normal', f.sessions[0], readNormal], ['bypass', createdSession, readBypass]]) {
      // The remote chat-submit requires a running session, so a sleeping one is
      // never exposed as chateable even with hooks, presence and rights.
      session.state = 'sleeping'
      const sleeping = await read()
      assert.equal(sleeping.canChat, false, `${mode} sleeping hides canChat`)
      assert.ok(!sleeping.allowedOperations.includes('chat'), `${mode} sleeping omits chat`)
      assert.equal(sleeping.state, 'sleeping', `${mode} still reports the real state`)
      session.state = 'running'
      // Working/unknown agents are not in the remote's waiting/completed idle set.
      for (const agentState of ['working', 'unknown']) {
        session.agentState = agentState
        const notIdle = await read()
        assert.equal(notIdle.canChat, false, `${mode} ${agentState} hides canChat`)
        assert.ok(!notIdle.allowedOperations.includes('chat'), `${mode} ${agentState} omits chat`)
        assert.equal(notIdle.agentState, agentState, `${mode} still reports the real agentState`)
      }
      session.agentState = 'waiting'
    }
    // Restoring running + idle re-exposes chat for both modes.
    assert.equal((await readNormal()).canChat, true)
    assert.equal((await readBypass()).canChat, true)
  } finally { f.cleanup() }
})

test('rename persists a prepared intent before the alias write, resumes it, and conflicts on a changed payload', async () => {
  const f = fixture()
  try {
    const client = f.clients[0]
    const original = f.workspace.renameSession.bind(f.workspace)
    let fail = true
    f.workspace.renameSession = (hostId, sessionId, name) => {
      if (fail) throw new Error('secret-alias-write-failure')
      return original(hostId, sessionId, name)
    }
    const requestId = randomUUID()
    await assert.rejects(f.service().renameTerminal(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'Alias escrito a medias', requestId), /secret-alias-write-failure/)
    // The prepared intent survived and the alias was NOT changed.
    assert.equal(f.workspace.sessionName(f.hosts[0].id, f.sessions[0].id), undefined)
    assert.equal(new BridgeRegistry(f.dir).findRename(client.id, requestId).state, 'prepared')
    // A changed payload with the same id conflicts before any write.
    await assert.rejects(f.service().renameTerminal(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'Otro nombre', requestId), /Conflicto de idempotencia/)
    assert.equal(f.workspace.sessionName(f.hosts[0].id, f.sessions[0].id), undefined)
    assert.equal(new BridgeRegistry(f.dir).findRename(client.id, requestId).state, 'prepared')
    // A retry of the exact same request resumes the prepared work and marks it applied.
    fail = false
    const applied = await f.service().renameTerminal(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'Alias escrito a medias', requestId)
    assert.equal(applied.name, 'Alias escrito a medias')
    assert.equal(f.workspace.sessionName(f.hosts[0].id, f.sessions[0].id), 'Alias escrito a medias')
    assert.equal(new BridgeRegistry(f.dir).findRename(client.id, requestId).state, 'applied')
    const replay = await f.service().renameTerminal(client, f.hosts[0].id, f.projects[0].id, f.sessions[0].id, 'Alias escrito a medias', requestId)
    assert.equal(replay.appliedAt, applied.appliedAt)
  } finally { f.cleanup() }
})

test('the rename registry stays compatible with absent renames and legacy applied rows', async () => {
  const f = fixture()
  try {
    // A registry written before this change has no `renames` key at all.
    new BridgeRegistry(f.dir)
    const base = JSON.parse(readFileSync(join(f.dir, 'bridge.json'), 'utf8'))
    delete base.renames
    writeFileSync(join(f.dir, 'bridge.json'), JSON.stringify(base))
    assert.doesNotThrow(() => new BridgeRegistry(f.dir))
    // The previous applied-only rename row (with appliedAt, without prepared)
    // keeps loading and stays readable.
    const requestId = randomUUID()
    const legacy = { ...base, renames: [{ requestId, clientId: 'client-0', hostId: f.hosts[0].id, hostRevision: 'a'.repeat(64),
      projectId: f.projects[0].id, sessionId: f.sessions[0].id, root: f.projects[0].root, name: 'Legado', via: 'grant',
      state: 'applied', createdAt: new Date().toISOString(), appliedAt: new Date().toISOString() }] }
    writeFileSync(join(f.dir, 'bridge.json'), JSON.stringify(legacy))
    const registry = new BridgeRegistry(f.dir)
    const row = registry.findRename('client-0', requestId)
    assert.equal(row.state, 'applied')
    assert.equal(row.name, 'Legado')
  } finally { f.cleanup() }
})
