import { describe, expect, it } from 'vitest'
import { parseConfig } from './appConfig'
import {
  accountChoices, accountEnvBlock, accountOverride, resumeAccount, accountForProject, accountForRepo, defaultAccount, githubSshAliases, groupByAccount, isMulti, keepLastGood,
  matchRepo, migrationAccount, noreplyEmail, parseGhUser, primaryLogin, prRepo, repoFromRemote, repoOfArgs, sessionAccount,
} from './accounts'

const A = { login: 'alice', primary: true, name: 'Alice', email: 'a@acme.test', owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [{ owner: 'acme', number: 1, columns: ['Todo', 'Done'] }] }
const B = { login: 'bob-work', name: 'Bob', email: 'b@globex.test', owner: 'globex', issueRepo: 'app', repos: ['globex/app'], allRepos: true, projects: [{ owner: 'globex', number: 7, columns: ['Backlog', 'Shipped'] }] }
const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [A, B] })
const one = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [A] })
const none = parseConfig({ owner: 'acme', issueRepo: 'tracker' })

describe('which account', () => {
  it('multi mode needs two accounts; the primary is first', () => {
    expect([isMulti(none), isMulti(one), isMulti(two)]).toEqual([false, false, true])
    expect([primaryLogin(none), primaryLogin(one), primaryLogin(two)]).toEqual([null, 'alice', 'alice'])
  })
  it('a repo: its account (case-insensitive), an org under "Select all", else the primary', () => {
    expect(matchRepo('ACME/API', two)).toBe('alice')
    expect(matchRepo(null, two)).toBe('alice')
    expect(matchRepo('globex/other', two)).toBe('bob-work')
    expect(matchRepo('initech/x', two)).toBeNull()
    expect(accountForRepo('initech/x', two)).toBe('alice')
    expect(accountForRepo('acme/api', none)).toBeNull()
  })
  it('a board: the account whose boards include it, else the primary', () => {
    expect(accountForProject('globex/7', two)).toBe('bob-work')
    expect(accountForProject('acme/1', two)).toBe('alice')
    expect(accountForProject(null, two)).toBe('alice')
    expect(accountForProject('initech/9', two)).toBe('alice')
  })
  it('a new session: the issue repo, then origin, then the primary', () => {
    expect(defaultAccount({ issue: { repo: 'globex/app' }, origin: 'acme/api' }, two)).toBe('bob-work')
    expect(defaultAccount({ issue: { repo: 'initech/x' }, origin: 'globex/app' }, two)).toBe('bob-work')
    expect(defaultAccount({ origin: 'initech/x' }, two)).toBe('alice')
    expect(defaultAccount({ issue: { repo: null } }, two)).toBe('alice')
  })
  it('a running session: recorded, spawned, origin, primary; a login no longer connected is skipped', () => {
    expect(sessionAccount({ recorded: 'bob-work', origin: 'acme/api' }, two)).toBe('bob-work')
    expect(sessionAccount({ recorded: 'gone-user', spawned: 'bob-work' }, two)).toBe('bob-work')
    expect(sessionAccount({ recorded: 'gone-user', origin: 'globex/app' }, two)).toBe('bob-work')
    expect(sessionAccount({}, two)).toBe('alice')
  })
  it('pickers offer healthy accounts, and nothing with one account', () => {
    expect(accountChoices(two, [{ login: 'bob-work', primary: false, healthy: false }])).toEqual(['alice'])
    expect(accountChoices(two, undefined)).toEqual(['alice', 'bob-work'])
    expect(accountChoices(one, undefined)).toEqual([])
  })
  it('groups PR URLs by account', () => {
    const g = groupByAccount(['https://github.com/acme/api/pull/1', 'https://github.com/globex/app/pull/2', 'https://github.com/acme/tracker/pull/3'], two)
    expect([...g]).toEqual([['alice', ['https://github.com/acme/api/pull/1', 'https://github.com/acme/tracker/pull/3']], ['bob-work', ['https://github.com/globex/app/pull/2']]])
    expect([...groupByAccount(['https://github.com/acme/api/pull/1'], none)]).toEqual([['', ['https://github.com/acme/api/pull/1']]])
    expect(prRepo('https://github.com/acme/api/pull/1')).toBe('acme/api')
    expect(prRepo('nope')).toBeNull()
  })
})

describe('repoFromRemote', () => {
  it('reads https, scp-style (any alias) and ssh:// remotes', () => {
    expect(repoFromRemote('https://github.com/acme/api.git\n')).toBe('acme/api')
    expect(repoFromRemote('https://x-access-token@github.com/acme/api')).toBe('acme/api')
    expect(repoFromRemote('git@github.com:acme/api.git')).toBe('acme/api')
    expect(repoFromRemote('git@github.com-work:globex/my.repo.git')).toBe('globex/my.repo')
    expect(repoFromRemote('ssh://git@github.com:443/acme/api')).toBe('acme/api')
    expect(repoFromRemote('https://gitlab.com/acme/api')).toBeNull()
    expect(repoFromRemote('nonsense')).toBeNull()
  })
})

describe('githubSshAliases', () => {
  it('takes every listed Host whose HostName is github.com; wildcards, negations and Match are skipped', () => {
    const text = [
      '# work',
      'Host github.com-work gh-work',
      '  HostName github.com',
      '  IdentityFile ~/.ssh/work',
      'Host=personal',
      '    hostname=GitHub.com',
      'Host *.corp !bad github-*',
      '  HostName github.com',
      'Host gitlab',
      '  HostName gitlab.com',
      'Host github.com',
      '  HostName github.com',
      'Host gh443',
      '  HostName ssh.github.com',
      'Match host foo',
      '  HostName github.com',
    ].join('\n')
    expect(githubSshAliases(text)).toEqual(['github.com-work', 'gh-work', 'personal', 'gh443'])
    expect(githubSshAliases('')).toEqual([])
  })
})

describe('accountEnvBlock', () => {
  it('sets the token, the identity and git rules that push every GitHub remote over HTTPS as this account', () => {
    const env = accountEnvBlock({ name: 'Bob B', email: '7+bob-work@users.noreply.github.com' }, 'gho_TOKEN', ['github.com-work'])
    expect(env.GH_TOKEN).toBe('gho_TOKEN')
    expect([env.GIT_AUTHOR_NAME, env.GIT_COMMITTER_NAME, env.GIT_AUTHOR_EMAIL, env.GIT_COMMITTER_EMAIL]).toEqual(['Bob B', 'Bob B', '7+bob-work@users.noreply.github.com', '7+bob-work@users.noreply.github.com'])
    const n = Number(env.GIT_CONFIG_COUNT)
    const pairs = Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]])
    expect(pairs).toEqual([
      ['user.name', 'Bob B'],
      ['user.email', '7+bob-work@users.noreply.github.com'],
      ['credential.https://github.com.helper', ''],
      ['credential.https://github.com.helper', '!gh auth git-credential'],
      ['url.https://github.com/.insteadOf', 'git@github.com:'],
      ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
      ['url.https://github.com/.insteadOf', 'git@github.com-work:'],
      ['url.https://github.com/.insteadOf', 'ssh://git@github.com-work/'],
    ])
  })
  it('resets the github.com credential helpers first (a keychain entry for another account must not answer)', () => {
    const env = accountEnvBlock({ name: 'x', email: 'y' }, 't'.repeat(20), [])
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper')
    expect(env.GIT_CONFIG_VALUE_2).toBe('')
    expect(env.GIT_CONFIG_VALUE_3).toBe('!gh auth git-credential')
  })
})

describe('migration', () => {
  it('keeps the identity commits use today; GitHub fills what git lacks', () => {
    const cfg = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [{ owner: 'acme', number: 1 }] })
    expect(migrationAccount(cfg, 'alice', { name: 'Alice A', email: 'alice@acme.test' }, { name: 'Alice GH', id: 5 })).toEqual({
      login: 'alice', primary: true, name: 'Alice A', email: 'alice@acme.test', owner: 'acme', ownerType: 'organization', issueRepo: 'tracker',
      repos: ['acme/tracker', 'acme/api'], allRepos: false, projects: cfg.projects, allProjects: false,
    })
    expect(migrationAccount(cfg, 'alice', { name: '', email: '' }, { name: null, id: 5 })).toMatchObject({ name: 'alice', email: '5+alice@users.noreply.github.com' })
    expect(noreplyEmail('bob-work', null)).toBe('bob-work@users.noreply.github.com')
  })

  it('the migrated config lists exactly the repos, boards, owner and issue repo it had', () => {
    const legacy = { owner: 'acme', issueRepo: 'tracker', repos: ['acme/api', 'acme/web'], allRepos: true, projects: [{ owner: 'acme', number: 1, columns: ['Todo', 'Done'] }] }
    const before = parseConfig(legacy)
    const after = parseConfig({ ...legacy, accounts: [migrationAccount(before, 'alice', { name: 'A', email: 'a@acme.test' }, { name: null, id: null })] })
    for (const k of ['owner', 'issueRepo', 'repos', 'allRepos', 'projects', 'allProjects'] as const) expect(after[k]).toEqual(before[k])
    expect(isMulti(after)).toBe(false)
  })
})

describe('parseGhUser', () => {
  it('reads login, name and id from `gh api user` JSON; null for anything unusable', () => {
    expect(parseGhUser('{"login":"bob-work","name":"Bob B","id":7,"x":1}')).toEqual({ login: 'bob-work', name: 'Bob B', id: 7 })
    expect(parseGhUser('{"login":"bob-work","name":null}')).toEqual({ login: 'bob-work', name: null, id: null })
    expect(parseGhUser('{"name":"x"}')).toBeNull()
    expect(parseGhUser('{"login":"bad login"}')).toBeNull()
    expect(parseGhUser('not json')).toBeNull()
  })
})

describe('the Start dialog default', () => {
  it("is the issue's account; only another pick is sent (and makes a new proposal)", () => {
    const def = defaultAccount({ issue: { repo: 'globex/app' } }, two)
    expect(def).toBe('bob-work')
    expect([accountOverride('bob-work', def, two), accountOverride('alice', def, two), accountOverride(null, def, two)]).toEqual([undefined, 'alice', undefined])
    expect(accountOverride('alice', 'bob-work', one)).toBeUndefined()
  })
})

describe('resumeAccount', () => {
  it('an untouched select resumes as the recorded account; a pick wins; one account sends none', () => {
    expect(resumeAccount('alice', 'bob-work', false, two)).toBe('alice')
    expect(resumeAccount(undefined, 'bob-work', false, two)).toBe('bob-work')
    expect(resumeAccount('alice', 'bob-work', true, two)).toBe('bob-work')
    expect(resumeAccount('alice', null, false, two)).toBe('alice')
    expect(resumeAccount(undefined, null, false, two)).toBeUndefined()
    expect(resumeAccount('alice', 'alice', true, one)).toBeUndefined()
  })
})

describe('repoOfArgs', () => {
  it('finds the repo a gh call is about', () => {
    expect(repoOfArgs(['pr', 'list', '-R', 'globex/app', '--json', 'url'])).toBe('globex/app')
    expect(repoOfArgs(['issue', 'view', '3', '--repo', 'acme/api'])).toBe('acme/api')
    expect(repoOfArgs(['pr', 'view', 'https://github.com/globex/app/pull/2', '--json', 'state'])).toBe('globex/app')
    expect(repoOfArgs(['api', 'user'])).toBeNull()
  })
  it('finds it in a REST path or an issue URL too', () => {
    expect(repoOfArgs(['api', 'repos/globex/app/issues/3/comments'])).toBe('globex/app')
    expect(repoOfArgs(['api', '/repos/globex/app/pulls?per_page=5'])).toBe('globex/app')
    expect(repoOfArgs(['issue', 'view', 'https://github.com/globex/app/issues/7'])).toBe('globex/app')
    expect(repoOfArgs(['api', 'repos/globex'])).toBeNull()
    expect(repoOfArgs(['api', 'search/issues?q=repos/globex/app/'])).toBeNull()
  })
})

describe('keepLastGood', () => {
  const issue = (repo: string | null, n: number) => ({ repo, number: n })
  it('one account: a failed board keeps every old issue, as before', () => {
    const out = keepLastGood({ sources: { board: false, prs: true }, issues: [], prs: [{ url: 'u2' }] }, { issues: [issue(null, 1)], prs: [{ url: 'u1' }] }, one)
    expect(out.issues).toEqual([issue(null, 1)])
    expect(out.prs).toEqual([{ url: 'u2' }])
  })
  it('two accounts: only the failed account keeps its old part', () => {
    const raw = { sources: { board: false, prs: true }, accounts: [{ login: 'alice', sources: { board: true } }, { login: 'bob-work', sources: { board: false } }], issues: [issue(null, 5)], prs: [] }
    expect(keepLastGood(raw, { issues: [issue(null, 1), issue('globex/app', 2)], prs: [] }, two).issues).toEqual([issue(null, 5), issue('globex/app', 2)])
  })
  it("two accounts: a row's own account wins over its repo's, and a failed PR read keeps only that account's PRs", () => {
    const pr = (url: string, account?: string) => ({ url, ...(account ? { account } : {}) })
    const raw = { sources: { board: true, prs: false }, accounts: [{ login: 'alice', sources: { prs: false } }, { login: 'bob-work', sources: { prs: true } }], issues: [], prs: [pr('https://github.com/globex/app/pull/9', 'bob-work')] }
    const prev = { issues: [], prs: [pr('https://github.com/acme/api/pull/1', 'alice'), pr('https://github.com/globex/app/pull/8', 'bob-work'), pr('https://github.com/globex/app/pull/7', 'alice')] }
    expect(keepLastGood(raw, prev, two).prs).toEqual([pr('https://github.com/globex/app/pull/9', 'bob-work'), pr('https://github.com/acme/api/pull/1', 'alice'), pr('https://github.com/globex/app/pull/7', 'alice')])
  })
  it('a row both fresh and kept from before is listed once, the fresh one', () => {
    const raw = { sources: { board: false, prs: false }, accounts: [{ login: 'alice', sources: { board: true, prs: true } }, { login: 'bob-work', sources: { board: false, prs: false } }],
      issues: [{ repo: 'globex/app', number: 2, title: 'new', account: 'alice' }], prs: [{ url: 'https://github.com/globex/app/pull/8', title: 'new', account: 'alice' }] }
    const prev = { issues: [{ repo: 'GLOBEX/app', number: 2, title: 'old', account: 'bob-work' }, issue('globex/app', 3)], prs: [{ url: 'https://github.com/globex/app/pull/8', title: 'old', account: 'bob-work' }] }
    const out = keepLastGood(raw, prev, two)
    expect(out.issues).toEqual([{ repo: 'globex/app', number: 2, title: 'new', account: 'alice' }, issue('globex/app', 3)])
    expect(out.prs).toEqual([{ url: 'https://github.com/globex/app/pull/8', title: 'new', account: 'alice' }])
  })
  it('nothing failed, or nothing before: the new lists as they came', () => {
    const raw = { sources: { board: true, prs: true }, issues: [issue(null, 5)], prs: [] }
    expect(keepLastGood(raw, { issues: [issue(null, 1)], prs: [{ url: 'u' }] }, two)).toEqual(raw)
    expect(keepLastGood({ ...raw, sources: { board: false, prs: false } }, null, one).issues).toEqual([issue(null, 5)])
  })
})
