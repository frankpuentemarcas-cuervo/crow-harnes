import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitLabTokenStore, listGitLabProjectFiles, readGitLabProjectFiles } from '../src/main/gitlab-repository.ts'

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).toString('base64')),
  decryptString: value => Buffer.from(value.toString(), 'base64').toString()
}

test('GitLab token is persisted encrypted and scoped by project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-gitlab-token-'))
  try {
    const store = new GitLabTokenStore(dir, encryption)
    store.save('project-1', 'glpat-secret')
    assert.equal(store.get('project-1'), 'glpat-secret')
    assert.equal(store.get('project-2'), undefined)
    assert.equal(readFileSync(join(dir, 'gitlab-tokens.enc'), 'utf8').includes('glpat-secret'), false)
    store.remove('project-1')
    assert.equal(store.get('project-1'), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GitLab source files work on GitLab.com or a configured custom HTTPS domain, with permission and strict bounds', async () => {
  const calls = []
  const request = async (url, options) => {
    calls.push({ url, options })
    if (url.includes('/repository/tree')) return new Response(JSON.stringify([
      { type: 'blob', path: 'src/main.ts' }, { type: 'blob', path: 'README.md' }, { type: 'blob', path: '.env' }, { type: 'tree', path: 'src' }
    ]), { status: 200 })
    return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('export const answer = 42').toString('base64') }), { status: 200 })
  }
  const project = { id: 'p1', gitlabUrl: 'https://gitlab.com/group/subgroup/project', allowGitLabRead: true }
  const listed = await listGitLabProjectFiles(project, 'read-token', request)
  assert.deepEqual(listed.files, ['src/main.ts', 'README.md'])
  const result = await readGitLabProjectFiles(project, ['src/main.ts'], 'read-token', request)
  assert.equal(result[0].content, 'export const answer = 42')
  assert.match(calls[0].url, /projects\/group%2Fsubgroup%2Fproject\/repository\/tree\?recursive=true/)
  assert.match(calls[2].url, /repository\/files\/src%2Fmain\.ts\?ref=HEAD/)
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers['PRIVATE-TOKEN'], 'read-token')
  await assert.rejects(listGitLabProjectFiles({ ...project, allowGitLabRead: false }, undefined, request), /permiso/)
  const customCalls = []
  const customRequest = async (url, options) => { customCalls.push({ url, options }); return request(url, options) }
  await listGitLabProjectFiles({ ...project, gitlabUrl: 'https://gitlab.acme.example/group/project' }, 'custom-token', customRequest)
  assert.match(customCalls[0].url, /^https:\/\/gitlab\.acme\.example\/api\/v4\//)
  await assert.rejects(listGitLabProjectFiles({ ...project, gitlabUrl: 'http://gitlab.acme.example/group/project' }, undefined, request), /HTTPS/)
  await assert.rejects(listGitLabProjectFiles({ ...project, gitlabUrl: 'https://localhost/group/project' }, undefined, request), /HTTPS/)
  await assert.rejects(readGitLabProjectFiles(project, ['.env'], undefined, request), /válidos/)
})

test('GitLab README errors do not disclose token or follow redirects', async () => {
  const request = async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response('not found', { status: 404 }) }
  await assert.rejects(listGitLabProjectFiles({ id: 'p1', gitlabUrl: 'https://gitlab.com/group/project', allowGitLabRead: true }, 'glpat-secret', request), /archivo/)
})
