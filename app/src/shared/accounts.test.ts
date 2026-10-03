import { describe, expect, it } from 'vitest'
import { parseConfig } from './appConfig'
import {
  accountChoices, accountEnvBlock, accountOverride, accountForProject, accountForRepo, defaultAccount, githubSshAliases, groupByAccount, isMulti,
  matchRepo, migrationAccount, noreplyEmail, parseGhUser, primaryLogin, prRepo, repoFromRemote, sessionAccount,
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
