import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '@shared/appConfig'
import { githubSshAliases } from '@shared/accounts'
import { AccountEnv, accountsInUse, githubSshRewrite, readSshConfig } from './accountEnv'
import type { Runner } from './run'

const A = { login: 'alice', primary: true, name: 'Alice', email: 'a@acme.test', owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker'] }
const B = { login: 'bob-work', name: 'Bob', email: 'b@globex.test', owner: 'globex', issueRepo: 'app', repos: ['globex/app'] }
const accounts = parseConfig({ accounts: [A, B] }).accounts
const TA = 'gho_' + 'a'.repeat(36)
const TB = 'gho_' + 'b'.repeat(36)
type Res = { code: number; stdout: string; stderr: string }

/** gh: `auth token --user` answers from `tokens`; `api user` from `user(token)`; git from `git`. Records calls. */
function fakeGh(tokens: Record<string, string>, user: (token: string) => Res, git: Res = { code: 1, stdout: '', stderr: '' }) {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = []
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env })
    if (cmd === 'git') return git
    if (args[0] === 'auth') {
      const l = args[args.indexOf('--user') + 1]
      return tokens[l] ? { code: 0, stdout: `${tokens[l]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: `no oauth token found for ${l}` }
    }
    return user(String(opts?.env?.GH_TOKEN))
  }
  return { run, calls }
}
const who = (byToken: Record<string, string>) => (t: string): Res =>
  byToken[t]
    ? { code: 0, stdout: JSON.stringify({ login: byToken[t], name: null, id: 1 }), stderr: '' }
    : { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)' }
function home() {
  const d = mkdtempSync(join(tmpdir(), 'acct-'))
  const ssh = join(d, 'ssh_config')
  writeFileSync(ssh, 'Host gh-work\n  HostName github.com\n')
  return { dir: join(d, 'accounts'), ssh }
}

describe('AccountEnv', () => {
  it('one account: no gh calls, no files, no --settings, no token env', async () => {
    const h = home()
    const f = fakeGh({ alice: TA }, who({ [TA]: 'alice' }))
    const e = new AccountEnv(h.dir, f.run, h.ssh)
    await e.refresh([accounts[0]])
    await e.check()
    expect(f.calls).toEqual([])
    expect(existsSync(h.dir)).toBe(false)
    expect(e.settingsArgs(null)).toEqual({ ok: true, args: [], account: null })
    expect(e.runEnv('alice')).toEqual({ env: {} })
    expect(e.status()).toEqual([{ login: 'alice', primary: true, healthy: true }])
  })

  it('two accounts: a 600 file each in a 700 folder, with the token and the ssh aliases; status never has a token', async () => {
    const h = home()
    const f = fakeGh({ alice: TA, 'bob-work': TB }, who({ [TA]: 'alice', [TB]: 'bob-work' }))
    const e = new AccountEnv(h.dir, f.run, h.ssh)
    await e.refresh(accounts)
    // Launch waits on this part only: local token reads, no network.
    expect(f.calls.map((c) => c.args[0])).toEqual(['auth', 'auth'])
    const file = e.file('bob-work')
    const env = JSON.parse(readFileSync(file, 'utf8')).env
    expect(env.GH_TOKEN).toBe(TB)
    expect(env.GIT_AUTHOR_EMAIL).toBe('b@globex.test')
    expect(Object.values(env)).toContain('git@gh-work:')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(h.dir).mode & 0o777).toBe(0o700)
    }
    await e.check()
    expect(e.settingsArgs('bob-work')).toEqual({ ok: true, args: ['--settings', file], account: 'bob-work' })
    expect(e.settingsArgs(null)).toMatchObject({ ok: true, account: 'alice' })
    expect(e.runEnv('bob-work')).toEqual({ env: { GH_TOKEN: TB, GHC_ACCOUNT: 'bob-work' } })
    expect(JSON.stringify(e.status())).not.toContain(TB)
    expect(f.calls.filter((c) => c.args[0] === 'api').map((c) => c.args)).toEqual([['api', 'user'], ['api', 'user']])
  })

  it('401 marks the account unhealthy, offline does not', async () => {
    const h = home()
    let offline = false
    const f = fakeGh({ alice: TA, 'bob-work': TB }, (t) => (offline ? { code: 1, stdout: '', stderr: 'error connecting to api.github.com' } : who({ [TA]: 'alice' })(t)))
    const e = new AccountEnv(h.dir, f.run, h.ssh)
    await e.refresh(accounts)
    await e.check()
    expect(e.status().find((s) => s.login === 'bob-work')).toMatchObject({ healthy: false, error: 'the token no longer works' })
    expect(e.settingsArgs('bob-work')).toEqual({ ok: false, message: 'GitHub account bob-work needs to log in again (Needs you → Log in)' })
    expect(e.runEnv('bob-work')).toEqual({ error: 'GitHub account bob-work needs to log in again' })
    offline = true
    await e.refresh(accounts)
    await e.check()
    expect(e.status().map((s) => [s.login, s.healthy])).toEqual([['alice', true], ['bob-work', false]])
  })

  it('a new token after a 401 counts as healthy again until GitHub says otherwise', async () => {
    const h = home()
    const tokens: Record<string, string> = { alice: TA, 'bob-work': TB }
    const TB2 = 'gho_' + 'd'.repeat(36)
    const e = new AccountEnv(h.dir, fakeGh(tokens, who({ [TA]: 'alice', [TB2]: 'bob-work' })).run, h.ssh)
    await e.refresh(accounts)
    await e.check()
    expect(e.status()[1].healthy).toBe(false)
    tokens['bob-work'] = TB2
    await e.refresh(accounts)
    expect(e.status()[1].healthy).toBe(true)
    expect(JSON.parse(readFileSync(e.file('bob-work'), 'utf8')).env.GH_TOKEN).toBe(TB2)
  })

  it('no gh login, or a token for someone else: unhealthy and no file; a login not connected is refused', async () => {
    const h = home()
    const e = new AccountEnv(h.dir, fakeGh({ alice: TA }, who({ [TA]: 'alice' })).run, h.ssh)
    await e.refresh(accounts)
    expect(existsSync(e.file('bob-work'))).toBe(false)
    expect(e.status()[1]).toMatchObject({ healthy: false, error: 'gh is not logged in to bob-work' })
    expect(e.settingsArgs('carol')).toEqual({ ok: false, message: 'carol is not a connected GitHub account' })
    const e2 = new AccountEnv(h.dir, fakeGh({ alice: TA, 'bob-work': TB }, who({ [TA]: 'alice', [TB]: 'mallory' })).run, h.ssh)
    await e2.refresh(accounts)
    await e2.check()
    expect(e2.status()[1]).toMatchObject({ healthy: false, error: 'the token is for mallory' })
    expect(existsSync(e2.file('bob-work'))).toBe(false)
  })

  it('keeps the file of a removed account while a session uses it, then removes it', async () => {
    const h = home()
    const e = new AccountEnv(h.dir, fakeGh({ alice: TA, 'bob-work': TB, carol: 'gho_' + 'c'.repeat(36) }, who({ [TA]: 'alice', [TB]: 'bob-work' })).run, h.ssh)
    await e.refresh(accounts)
    const withCarol = parseConfig({ accounts: [A, { login: 'carol', name: 'C', email: 'c@initech.test' }] }).accounts
    await e.refresh(withCarol, new Set(['bob-work']))
    expect(existsSync(e.file('bob-work'))).toBe(true)
    await e.refresh(withCarol, new Set())
    expect(existsSync(e.file('bob-work'))).toBe(false)
  })

  it('back to one account: every file not in use goes, the one account\'s too', async () => {
    const h = home()
    const e = new AccountEnv(h.dir, fakeGh({ alice: TA, 'bob-work': TB }, who({})).run, h.ssh)
    await e.refresh(accounts)
    await e.refresh([accounts[0]], new Set(['bob-work']))
    expect(existsSync(e.file('alice'))).toBe(false)
    expect(existsSync(e.file('bob-work'))).toBe(true)
    await e.refresh([accounts[0]])
    expect(existsSync(e.file('bob-work'))).toBe(false)
  })

  it('a global git rule that sends https://github.com/ over SSH is a warning on every account', async () => {
    const h = home()
    const git = { code: 0, stdout: 'url.git@github.com:.insteadof https://github.com/\n', stderr: '' }
    const f = fakeGh({ alice: TA, 'bob-work': TB }, who({ [TA]: 'alice', [TB]: 'bob-work' }), git)
    const e = new AccountEnv(h.dir, f.run, h.ssh)
    await e.refresh(accounts)
    await e.check()
    expect(f.calls.find((c) => c.cmd === 'git')?.args).toEqual(['config', '--global', '--get-regexp', '^url\\..*\\.(push)?insteadof$'])
    for (const s of e.status()) expect(s.warning).toMatch(/your git config sends GitHub pushes over SSH; sessions may push as the SSH key's account/)
  })
})

describe('githubSshRewrite', () => {
  it('finds insteadOf / pushInsteadOf rules from https://github.com to an SSH form only', () => {
    expect(githubSshRewrite('url.git@github.com:.insteadof https://github.com/')).toBe('url.git@github.com:.insteadof https://github.com/')
    expect(githubSshRewrite('url.ssh://git@github.com/.pushinsteadof https://github.com')).toBe('url.ssh://git@github.com/.pushinsteadof https://github.com')
    expect(githubSshRewrite('url.git@gh-work:.pushInsteadOf https://github.com/acme/')).toBe('url.git@gh-work:.pushInsteadOf https://github.com/acme/')
    expect(githubSshRewrite('url.https://github.com/.insteadof git@github.com:')).toBeNull()
    expect(githubSshRewrite('url.git@gitlab.com:.insteadof https://gitlab.com/')).toBeNull()
    expect(githubSshRewrite('url.https://mirror.test/.insteadof https://github.com/')).toBeNull()
    expect(githubSshRewrite('')).toBeNull()
  })
})

describe('accountsInUse', () => {
  it('logins of live sessions in session-accounts.json, by id or key; missing or broken file is empty', () => {
    const d = mkdtempSync(join(tmpdir(), 'sa-'))
    const f = join(d, 'session-accounts.json')
    expect(accountsInUse(f, [])).toEqual(new Set())
    writeFileSync(f, '{nope')
    expect(accountsInUse(f, null)).toEqual(new Set())
    writeFileSync(f, JSON.stringify({ s1: 'bob-work', k2: 'carol', s3: 'dave', s4: 'bad login!' }))
    const live = [
      { sessionId: 's1', key: 'k1', state: 'idle' as const },
      { sessionId: 's2', key: 'k2', state: 'working' as const },
      { sessionId: 's3', key: 'k3', state: 'done' as const },
    ]
    expect(accountsInUse(f, live)).toEqual(new Set(['bob-work', 'carol']))
    // Sessions not known yet (launch): every recorded login counts.
    expect(accountsInUse(f, null)).toEqual(new Set(['bob-work', 'carol', 'dave']))
  })
})

describe('readSshConfig', () => {
  it('follows Include: relative to the config folder, absolute, globs; stops after 5 levels', () => {
    const d = mkdtempSync(join(tmpdir(), 'ssh-'))
    mkdirSync(join(d, 'conf.d'))
    writeFileSync(join(d, 'config'), `Include conf.d/*.conf\nInclude ${join(d, 'extra')}\nHost main\n  HostName github.com\n`)
    writeFileSync(join(d, 'conf.d', 'a.conf'), 'Host work-a\n  HostName github.com\n')
    writeFileSync(join(d, 'conf.d', 'b.txt'), 'Host not-included\n  HostName github.com\n')
    writeFileSync(join(d, 'extra'), 'Host extra\n  HostName github.com\nInclude extra\n')
    expect(githubSshAliases(readSshConfig(join(d, 'config')))).toEqual(['main', 'work-a', 'extra'])
    expect(readSshConfig(join(d, 'missing'))).toBe('')
  })
})
