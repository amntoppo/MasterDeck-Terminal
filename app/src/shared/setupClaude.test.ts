import { describe, expect, it } from 'vitest'
import type { DetectAll, DetectedBoard } from './detect'
import { parseConfig } from './appConfig'
import { draftSummary, readSetupDraft, setupBriefing, setupScript } from './setupClaude'

const board = (owner: string, number: number, title: string, columns: string[], closed = false): DetectedBoard => ({
  ...parseConfig({ projects: [{ owner, number }] }).projects[0],
  title,
  columns,
  closed,
  items: 3,
})
const found: Record<string, DetectAll> = {
  alice: {
    user: 'alice',
    owners: [
      { login: 'alice', type: 'user', repos: [{ repo: 'alice/dots', openIssues: 0 }], projects: [] },
      {
        login: 'acme',
        type: 'organization',
        repos: [
          { repo: 'acme/api', openIssues: 4 },
          { repo: 'acme/web', openIssues: 1 },
        ],
        projects: [board('acme', 3, 'Team board', ['Todo', 'In Progress', 'Done']), board('acme', 9, 'Old', ['A'], true)],
      },
    ],
  },
  'Bob-Work': {
    user: 'Bob-Work',
    owners: [
      { login: 'globex', type: 'organization', repos: [{ repo: 'globex/app', openIssues: 2 }, { repo: 'acme/web', openIssues: 1 }], projects: [board('globex', 7, 'Globex', ['Ready', 'Doing'])] },
    ],
  },
}
const ctx = { logins: ['alice', 'Bob-Work'], found }

describe('readSetupDraft', () => {
  it('one account is the primary; its main repository leads; unset settings stay unset', () => {
    const r = readSetupDraft({ accounts: [{ login: 'ALICE', repos: ['acme/web', 'acme/api'], primaryRepo: 'acme/api', boards: [{ owner: 'acme', number: 3 }] }] }, ctx)
    expect(r).toEqual({
      ok: true,
      draft: {
        accounts: [{ login: 'alice', primary: true, repos: ['acme/api', 'acme/web'], allRepos: false, primaryRepo: 'acme/api', boards: ['acme/3'], allBoards: false, workspace: '' }],
      },
    })
  })

  it('several accounts need exactly one primary', () => {
    const r = readSetupDraft({ accounts: [{ login: 'alice', repos: ['acme/api'] }, { login: 'bob-work', repos: ['globex/app'] }] }, ctx)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors.join(' ')).toContain('exactly one account as primary')
  })

  it('refuses a login gh does not know, or one never discovered', () => {
    const r = readSetupDraft({ accounts: [{ login: 'mallory', repos: 'all' }] }, ctx)
    expect(!r.ok && r.errors[0]).toContain('gh is not logged in to mallory')
    const r2 = readSetupDraft({ accounts: [{ login: 'carol', repos: 'all' }] }, { logins: ['carol'], found })
    expect(!r2.ok && r2.errors[0]).toContain('discover carol')
  })

  it('refuses repositories and boards discover did not list, and a repository in two accounts', () => {
    const r = readSetupDraft({ accounts: [{ login: 'alice', primary: true, repos: ['acme/nope', 'acme/web'], boards: [{ owner: 'acme', number: 4 }] }, { login: 'bob-work', repos: ['acme/web'] }] }, ctx)
    expect(r.ok).toBe(false)
    const text = !r.ok ? r.errors.join('\n') : ''
    expect(text).toContain('acme/nope')
    expect(text).toContain('no board acme/4')
    expect(text).toContain('acme/web is picked for both alice and Bob-Work')
  })

  it('"all" takes what named picks left, primary first, and skips closed boards', () => {
    const r = readSetupDraft(
      {
        accounts: [
          { login: 'bob-work', repos: 'all', boards: 'all', workspace: '~/work' },
          { login: 'alice', primary: true, repos: 'all', boards: 'all' },
        ],
        workspace: '~/code',
        masterEnabled: false,
        mods: true,
      },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.accounts.map((a) => a.login)).toEqual(['alice', 'Bob-Work'])
    expect(r.draft.accounts[0]).toMatchObject({ repos: ['alice/dots', 'acme/api', 'acme/web'], allRepos: true, boards: ['acme/3'], allBoards: true })
    expect(r.draft.accounts[1]).toMatchObject({ repos: ['globex/app'], boards: ['globex/7'], workspace: '~/work' })
    expect(r.draft).toMatchObject({ workspace: '~/code', masterEnabled: false, mods: true })
  })

  it('the primary needs a repository; settings must have the right type', () => {
    const r = readSetupDraft({ accounts: [{ login: 'alice', repos: [] }], workspace: 'a\nb', notifications: 'yes' }, ctx)
    const text = !r.ok ? r.errors.join('\n') : ''
    expect(text).toContain('needs at least one repository')
    expect(text).toContain('"workspace" must be a folder path')
    expect(text).toContain('"notifications" must be true or false')
    expect(readSetupDraft(null, ctx).ok).toBe(false)
    expect(readSetupDraft({ accounts: [] }, ctx).ok).toBe(false)
  })
})

describe('draftSummary', () => {
  it('names accounts, repositories, boards with their columns, and the settings', () => {
    const r = readSetupDraft(
      { accounts: [{ login: 'alice', primary: true, repos: ['acme/api'], boards: [{ owner: 'acme', number: 3 }] }, { login: 'bob-work', repos: 'all', boards: [] }], masterEnabled: true, notifications: false, mods: true },
      ctx,
    )
    if (!r.ok) throw new Error(r.errors.join())
    expect(draftSummary(r.draft, found)).toEqual([
      'GitHub accounts: alice (primary), Bob-Work',
      'alice: 1 repository, main acme/api',
      'alice: board Team board (Todo → In Progress → Done)',
      'Bob-Work: all 2 repositories, main globex/app',
      'Bob-Work: no project board (issues and PRs only)',
      'master-agent: on',
      'Notifications: off',
      "MasterDeck's mods: install",
    ])
  })
})

describe('the briefing and the helper', () => {
  it('the briefing names every tool and the platform installer', () => {
    const mac = setupBriefing('darwin')
    for (const t of ['claude', 'gh', 'python', 'git', 'jq', 'brew install', 'gh-login', 'review review.json', 'Only the user\'s Save writes the setup'])
      expect(mac).toContain(t)
    expect(setupBriefing('win32')).toContain('winget install --id')
  })
  it('the helper quotes its folder and takes Windows paths with forward slashes', () => {
    expect(setupScript("/h/it's", 'darwin')).toContain(`d='/h/it'\\''s'`)
    expect(setupScript('C:\\Users\\a\\setup-claude', 'win32')).toContain("d='C:/Users/a/setup-claude'")
  })
})
