import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store.ts'

test('local project catalog retains summary, tags and a safe GitLab reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crow-project-catalog-'))
  try {
    const store = new Store(dir)
    const host = store.saveHost({ name: 'Dev', target: 'dev@example.org', port: 22, remotePort: 47321 }).hosts[0]
    const project = store.saveProject({ hostId: host.id, name: 'Recruiting', root: '/workspace/recruiting', summary: 'ATS interno', tags: [' RRHH ', 'erp', 'RRHH'], gitlabUrl: 'https://gitlab.com/team/recruiting.git', allowGitLabRead: true, gitlabToken: 'not-persisted' }).projects[0]
    assert.deepEqual({ summary: project.summary, tags: project.tags, gitlabUrl: project.gitlabUrl, allowGitLabRead: project.allowGitLabRead }, { summary: 'ATS interno', tags: ['rrhh', 'erp'], gitlabUrl: 'https://gitlab.com/team/recruiting', allowGitLabRead: true })
    assert.equal(JSON.stringify(store.snapshot()).includes('not-persisted'), false)
    const selfHosted = store.saveProject({ hostId: host.id, name: 'Self Hosted', root: '/workspace/self-hosted', gitlabUrl: 'https://gitlab.acme.example/team/app' }).projects.at(-1)
    assert.equal(selfHosted.gitlabUrl, 'https://gitlab.acme.example/team/app')
    assert.throws(() => store.saveProject({ ...project, gitlabUrl: 'https://user:secret@gitlab.com/team/recruiting' }), /URL HTTPS/)
    assert.throws(() => store.saveProject({ ...project, gitlabUrl: 'https://gitlab.com/team/recruiting?token=secret' }), /URL HTTPS/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
