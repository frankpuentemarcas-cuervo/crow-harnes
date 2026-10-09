import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AccountUsageError, accountUsageEnvironment, createAccountUsageAdapters, parseClaudeUsage, parseCodexUsage, readClaudeProfileCredentials, validateCodexAuthURL } from '../src/main/account-usage-adapters.ts'

test('normalizes provider quotas with milliseconds and preserves unknown reset fields', () => {
  assert.deepEqual(parseCodexUsage({ rateLimits: { primary: { usedPercent: 0, resetsAt: 1700000000, windowDurationMins: 300 } } }), [{ id: 'codex:primary', label: 'codex · 5 horas', usedPercent: 0, resetsAt: 1700000000000, windowMinutes: 300 }])
  const claude = parseClaudeUsage({ five_hour: { utilization: 25.5, resets_at: null } })[0]
  assert.equal(claude.usedPercent, 25.5)
  assert.equal(claude.resetsAt, undefined)
  const buckets = parseCodexUsage({ rateLimits: { primary: { usedPercent: 90 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 42 } }, other: { secondary: { usedPercent: 75 } } } })
  assert.deepEqual(buckets.map(w => w.usedPercent), [42, 75])
})
test('malformed, out-of-range and absent quotas never become zero consumption', () => {
  for (const bad of [-1, 101, '50', null, NaN, Infinity]) {
    assert.throws(() => parseCodexUsage({ rateLimits: { primary: { usedPercent: bad } } }), AccountUsageError)
    assert.throws(() => parseClaudeUsage({ five_hour: { utilization: bad } }), AccountUsageError)
  }
  assert.throws(() => parseCodexUsage({}), AccountUsageError)
  assert.throws(() => parseClaudeUsage({}), AccountUsageError)
  assert.throws(() => parseClaudeUsage({ five_hour: { utilization: 10, resets_at: 'tomorrow' } }), AccountUsageError)
  assert.throws(() => parseCodexUsage({ rateLimits: { primary: { usedPercent: 10, resetsAt: -1 } } }), AccountUsageError)
})
test('Codex temporal labels use provider metadata, not guesses about secondary windows', () => {
  const windows = parseCodexUsage({ rateLimits: { primary: { usedPercent: 1 }, secondary: { usedPercent: 2, windowDurationMins: 60 } } })
  assert.equal(windows[0].label, 'codex · Principal'); assert.equal(windows[1].label, 'codex · 60 minutos')
})
test('credential reader rejects oversized files and symlinks before reading contents', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'crow-usage-test-'))
  try {
    const file = resolve(root, 'credentials.json')
    await writeFile(file, 'x'.repeat(65537)); await assert.rejects(readClaudeProfileCredentials(file), AccountUsageError)
    await writeFile(file, '{"fixture":true}'); assert.equal(await readClaudeProfileCredentials(file), '{"fixture":true}')
    const link = resolve(root, 'credentials-link.json')
    try { await symlink(file, link) } catch (e) { if (e.code === 'EPERM') { t.diagnostic('Windows lacks file-symlink privilege; symlink assertion unavailable'); return } throw e }
    await assert.rejects(readClaudeProfileCredentials(link), AccountUsageError)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('auth URL allowlist rejects credentials, ports and lookalike hosts', () => {
  assert.equal(validateCodexAuthURL('https://auth.openai.com/oauth/authorize?a=b'), 'https://auth.openai.com/oauth/authorize?a=b')
  for (const url of ['https://auth.openai.com.evil.test/a', 'http://auth.openai.com/a', 'https://secret@chatgpt.com/a', 'https://chatgpt.com:444/a', 'javascript:alert(1)', null]) assert.throws(() => validateCodexAuthURL(url), AccountUsageError)
})
test('provider environment strips inherited secrets and backend overrides', () => {
  const env = accountUsageEnvironment('codex', 'profiles/test', { PATH: 'safe-path', OPENAI_API_KEY: 'secret', CODEX_HOME: 'global', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://evil.test', CODEX_AUTH_JSON: 'secret' })
  assert.deepEqual(env, { PATH: 'safe-path', CODEX_HOME: resolve('profiles/test'), ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(accountUsageEnvironment('claude', 'profiles/a', {}).CLAUDE_CONFIG_DIR, resolve('profiles/a'))
})
function fakeRPC(reply) {
  const calls = []
  const children = []
  return { calls, children, spawn(file, args, options) {
    calls.push({ file, args, options })
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => { child.emit('exit', 0); return true }
    let buffer = ''
    child.stdin.on('data', data => {
      buffer += data.toString()
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'); const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
        const response = reply(request, child)
        if (request.id && response !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: response }) + '\n'))
      }
    })
    children.push(child)
    return child
  } }
}
test('Codex uses official protocol, isolated profile, no prompt requests', async () => {
  const methods = []
  const fake = fakeRPC(request => {
    methods.push(request.method)
    if (request.method === 'initialize') return {}
    if (request.method === 'account/read') return { account: { type: 'chatgpt', email: 'test@example.com' } }
    if (request.method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 40 } } }
  })
  const adapters = createAccountUsageAdapters({ spawn: fake.spawn, resolveCLI: async () => ({ file: 'official.exe', args: [] }) })
  const usage = await adapters.codex.usage('isolated-codex')
  assert.equal(usage.identity, 'test@example.com'); assert.equal(usage.windows[0].usedPercent, 40)
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read'])
  assert.equal(fake.calls[0].options.env.CODEX_HOME, resolve('isolated-codex'))
  assert.equal(fake.calls[0].options.cwd, resolve('isolated-codex'))
  assert.equal(fake.calls[0].options.shell, undefined)
})
test('Codex browser login waits for matching completion without copying OAuth identifiers', async () => {
  let opened
  const fake = fakeRPC((request, child) => {
    if (request.method === 'initialize') return {}
    if (request.method === 'account/login/start') {
      assert.deepEqual(request.params, { type: 'chatgpt' })
      setTimeout(() => child.stdout.write(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'test-id', success: true } }) + '\n'), 10)
      return { type: 'chatgpt', loginId: 'test-id', authUrl: 'https://auth.openai.com/oauth/authorize' }
    }
  })
  await createAccountUsageAdapters({ spawn: fake.spawn, resolveCLI: async () => ({ file: 'official.exe', args: [] }), openExternal: async url => { opened = url } }).codex.login('isolated-codex')
  assert.equal(opened, 'https://auth.openai.com/oauth/authorize')
})
test('Codex disconnect during login rejects immediately instead of leaving five-minute timer', async () => {
  const fake = fakeRPC((request, child) => {
    if (request.method === 'initialize') return {}
    if (request.method === 'account/login/start') {
      setTimeout(() => child.emit('exit', 1), 10)
      return { type: 'chatgpt', loginId: 'test-id', authUrl: 'https://auth.openai.com/oauth/authorize' }
    }
  })
  const started = Date.now()
  await assert.rejects(createAccountUsageAdapters({ spawn: fake.spawn, resolveCLI: async () => ({ file: 'official.exe', args: [] }), openExternal: async () => {} }).codex.login('isolated'), error => error.code === 'error')
  assert.ok(Date.now() - started < 1000)
})
test('Claude login explicitly launches a real interactive console, not piped CLI prompts', { skip: process.platform !== 'win32' }, async () => {
  let observed
  const spawn = (file, args, options) => {
    observed = { file, args, options }
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    queueMicrotask(() => child.emit('exit', 0))
    return child
  }
  await createAccountUsageAdapters({ spawn, resolveCLI: async () => ({ file: 'official-claude.exe', args: [] }) }).claude.login('isolated')
  assert.equal(observed.options.windowsHide, true)
  const script = Buffer.from(observed.args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /Start-Process/); assert.match(script, /WindowStyle Normal/)
  assert.equal(observed.options.env.CLAUDE_CONFIG_DIR, resolve('isolated'))
  assert.equal(observed.options.env.CROW_USAGE_EXECUTABLE, 'official-claude.exe')
  assert.deepEqual(JSON.parse(observed.options.env.CROW_USAGE_ARGS), ['auth', 'login'])
})
test('Claude reads ONLY its isolated profile and fetches fixed bounded endpoint', async () => {
  const reads = []
  const adapters = createAccountUsageAdapters({ readFile: async path => { reads.push(path); return JSON.stringify({ claudeAiOauth: { accessToken: 'fake-secret', expiresAt: Date.now() + 60000 } }) }, fetch: async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage')
    assert.equal(init.headers.Authorization, 'Bearer fake-secret')
    assert.equal(init.headers['anthropic-beta'], 'oauth-2025-04-20'); assert.equal(init.redirect, 'error')
    assert.ok(init.signal)
    return new Response(JSON.stringify({ five_hour: { utilization: 30 } }))
  } })
  assert.equal((await adapters.claude.usage('isolated-claude')).windows[0].usedPercent, 30)
  assert.equal(reads.length, 1); assert.equal(reads[0], resolve('isolated-claude', '.credentials.json'))
})
test('missing/expired Claude profile credentials never fall back to global credentials', async () => {
  let calls = 0
  for (const read of [async () => { throw Error('fake-secret-path') }, async () => JSON.stringify({ claudeAiOauth: { accessToken: 'fake-secret', expiresAt: 1 } })]) {
    const adapter = createAccountUsageAdapters({ readFile: read, fetch: async () => { calls++; throw Error('must not fetch') } }).claude
    await assert.rejects(adapter.usage('isolated-claude'), error => error.code === 'signed-out' && !error.message.includes('fake-secret'))
  }
  assert.equal(calls, 0)
})
test('Claude sanitizes failures, honors rate limits and rejects oversized responses', async () => {
  const readFile = async () => JSON.stringify({ claudeAiOauth: { accessToken: 'fake-secret' } })
  for (const [status, code] of [[401, 'signed-out'], [403, 'unsupported'], [429, 'rate-limited'], [500, 'error']]) {
    const adapter = createAccountUsageAdapters({ readFile, fetch: async () => new Response('fake-secret', { status, headers: { 'retry-after': '900' } }) }).claude
    await assert.rejects(adapter.usage('isolated'), error => error.code === code && !error.message.includes('fake-secret') && (status !== 429 || error.retryAt > Date.now()))
  }
  await assert.rejects(createAccountUsageAdapters({ readFile, fetch: async () => new Response('x'.repeat(65537)) }).claude.usage('isolated'), error => error.code === 'unsupported')
  await assert.rejects(createAccountUsageAdapters({ readFile, fetch: async () => { throw Error('fake-secret') } }).claude.usage('isolated'), error => error.code === 'error' && !error.message.includes('fake-secret'))
})
test('dispose prevents delayed CLI resolution or credential reads from starting new work', async () => {
  let releaseCLI, releaseRead, spawned = 0, fetched = 0
  const adapters = createAccountUsageAdapters({ resolveCLI: () => new Promise(resolve => { releaseCLI = resolve }), spawn: () => { spawned++; throw Error('unexpected spawn') } })
  const pendingCLI = adapters.codex.usage('isolated'); adapters.codex.dispose()
  releaseCLI({ file: 'official.exe', args: [] })
  await assert.rejects(pendingCLI, error => error.code === 'error'); assert.equal(spawned, 0)
  const claude = createAccountUsageAdapters({ readFile: () => new Promise(resolve => { releaseRead = resolve }), fetch: () => { fetched++; throw Error('unexpected fetch') } }).claude
  const pendingRead = claude.usage('isolated'); claude.dispose()
  releaseRead(JSON.stringify({ claudeAiOauth: { accessToken: 'fake-secret' } }))
  await assert.rejects(pendingRead, error => error.code === 'error'); assert.equal(fetched, 0)
})
test('dispose aborts an active quota request', async () => {
  let started
  const adapter = createAccountUsageAdapters({ readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'fake-secret' } }), fetch: async (url, init) => {
    started = true
    return await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted fixture'))))
  } }).claude
  const pending = adapter.usage('isolated')
  while (!started) await new Promise(resolve => setImmediate(resolve))
  adapter.dispose(); await assert.rejects(pending, error => error.code === 'error')
})
