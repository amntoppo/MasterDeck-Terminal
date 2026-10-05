import { describe, expect, it } from 'vitest'
import { parseConfig } from '@shared/appConfig'
import type { AccountRunEnv } from './accountEnv'
import { accountClients, type Clients } from './accountClients'
import { BoardOps } from './boardOps'
import { makeGhRunner, type GhRunner } from './ghc'
import { GitHub } from './github'
import type { RunOpts, Runner } from './run'

const alice = { login: 'alice', primary: true, owner: 'acme', issueRepo: 'web', repos: ['acme/web'] }
const bob = { login: 'bob-work', owner: 'globex', issueRepo: 'app', repos: ['globex/app'] }
const one = parseConfig({ accounts: [alice] })
const two = parseConfig({ accounts: [alice, bob] })

function setup(cfg = two, bad: string[] = []) {
  const calls: { cmd: string; args: string[]; opts?: RunOpts }[] = []
  const run: Runner = async (cmd, args, opts) => (calls.push({ cmd, args, opts }), { code: 0, stdout: '{}', stderr: '' })
  const baseCalls: string[][] = []
  const baseGh: GhRunner = async (args) => (baseCalls.push(args), { code: 0, stdout: '{}', stderr: '' })
  const base: Clients = { gh: baseGh, github: new GitHub(run, baseGh), ops: new BoardOps(baseGh) }
  let made = 0
  const runEnv = (l: string): AccountRunEnv => (bad.includes(l) ? { error: `GitHub account ${l} needs to log in again` } : { env: { GH_TOKEN: `tok-${l}`, GHC_ACCOUNT: l } })
  const c = accountClients({
    config: () => cfg,
    base,
    run,
    runEnv,
    // win32: gh is called directly, so the fake run sees each call's env.
    ghFor: (account) => (made++, makeGhRunner(run, '/lib', 'python3', 'win32', account)),
  })
  const as = () => calls.map((x) => x.opts?.env?.GHC_ACCOUNT ?? 'default')
  return { c, base, baseCalls, calls, as, made: () => made }
}

describe('accountClients', () => {
  it('one account: every call uses the default runner as before, and no per-account runner is made', async () => {
    const s = setup(one)
    expect(s.c.forAccount('alice')).toBe(s.base)
    expect(s.c.forRepo('globex/app')).toBe(s.base)
    await s.c.ghRouted(['pr', 'list', '-R', 'globex/app'], { ttl: 600 })
    await s.c.boardOps.linkPr({ repo: 'globex/app', number: 2 }, 'https://github.com/globex/app/pull/2')
    expect(s.baseCalls[0]).toEqual(['pr', 'list', '-R', 'globex/app'])
    expect(s.baseCalls.length).toBeGreaterThan(1)
    await s.c.ghDirect('acme/web', ['issue', 'comment', '1'], { stdin: 'x', timeoutMs: 5 })
    expect(s.calls).toEqual([{ cmd: 'gh', args: ['issue', 'comment', '1'], opts: { stdin: 'x', timeoutMs: 5 } }])
    expect(s.made()).toBe(0)
  })

  it("two accounts: a repo's calls go as its account, one runner per account; unknown repos and logins are the primary's", async () => {
    const s = setup()
    expect(s.c.forRepo('globex/app')).toBe(s.c.forAccount('bob-work'))
    expect(s.c.forRepo(null)).toBe(s.c.forAccount('alice'))
    expect(s.c.forAccount('mallory')).toBe(s.c.forAccount('alice'))
    expect(s.made()).toBe(2)
    await s.c.ghRouted(['pr', 'view', 'https://github.com/globex/app/pull/2'])
    await s.c.ghRouted(['pr', 'list', '-R', 'acme/web'])
    await s.c.ghRouted(['api', 'user'])
    await s.c.ghDirect('globex/app', ['issue', 'comment', '1'], { stdin: 'x' })
    expect(s.as()).toEqual(['bob-work', 'alice', 'alice', 'bob-work'])
    expect(s.calls[3].opts).toMatchObject({ stdin: 'x', env: { GH_TOKEN: 'tok-bob-work' } })
    expect(s.baseCalls).toEqual([])
  })

  it("BoardFlow's moves and PR links go as the ticket's repo's account", async () => {
    const s = setup()
    await s.c.boardOps.move({ repo: 'globex/app', number: 2 }, 'In Dev')
    await s.c.boardOps.linkPr({ repo: 'globex/app', number: 2 }, 'https://github.com/globex/app/pull/2')
    const n = s.calls.length
    expect(n).toBeGreaterThan(0)
    await s.c.boardOps.move({ repo: null, number: 3 }, 'In Dev')
    expect(s.as().slice(0, n).every((a) => a === 'bob-work')).toBe(true)
    expect(s.as().slice(n).every((a) => a === 'alice')).toBe(true)
    expect(s.baseCalls).toEqual([])
  })

  it("an account AccountEnv has not read yet (no token in its env) is not ready: no call runs as gh's active account", async () => {
    const calls: RunOpts[] = []
    const run: Runner = async (_c, _a, opts) => (calls.push(opts ?? {}), { code: 0, stdout: '{}', stderr: '' })
    const baseGh: GhRunner = (args, opts) => run('gh', args, opts)
    const base: Clients = { gh: baseGh, github: new GitHub(run, baseGh), ops: new BoardOps(baseGh) }
    // Config already has two accounts; AccountEnv still has one, so it answers {env: {}}.
    const c = accountClients({ config: () => two, base, run, runEnv: () => ({ env: {} }), ghFor: (a) => makeGhRunner(run, '/lib', 'python3', 'win32', a) })
    const r = await c.forRepo('globex/app').gh(['pr', 'list', '-R', 'globex/app'])
    const d = await c.ghDirect('globex/app', ['issue', 'comment', '1'], { stdin: 'x' })
    expect([r.code, d.code]).toEqual([1, 1])
    expect(r.stderr).toBe('GitHub account bob-work is not ready yet')
    expect(d.stderr).toBe('GitHub account bob-work is not ready yet')
    expect(calls).toEqual([])
  })

  it('an account without a usable token fails its calls visibly, never as another account', async () => {
    const s = setup(two, ['bob-work'])
    const r = await s.c.ghRouted(['pr', 'list', '-R', 'globex/app'])
    const d = await s.c.ghDirect('globex/app', ['issue', 'comment', '1'], { stdin: 'x' })
    const m = await s.c.boardOps.move({ repo: 'globex/app', number: 2 }, 'In Dev')
    expect([r.code, d.code]).toEqual([1, 1])
    expect(r.stderr).toContain('bob-work needs to log in again')
    expect(d.stderr).toContain('bob-work needs to log in again')
    expect(m.ok).toBe(false)
    expect(s.calls).toEqual([])
    expect(s.baseCalls).toEqual([])
  })
  it('assigning an issue, and reading who can be assigned, run as the account of the issue\'s repository', async () => {
    const s = setup()
    await s.c.forRepo('globex/app').github.assign({ repo: 'globex/app', number: 7 }, 'zoe', [])
    await s.c.forRepo('globex/app').github.assignableUsers(false, 'globex/app')
    await s.c.forRepo('acme/web').github.assignableUsers(false, 'acme/web')
    await s.c.forRepo(null).github.assign({ repo: null, number: 7 }, 'zoe', [])
    // A repository no account lists (a card of a board can be in one): assigned and read as the primary, alike.
    await s.c.forRepo('partner/portal').github.assign({ repo: 'partner/portal', number: 7 }, 'zoe', [])
    await s.c.forRepo('partner/portal').github.assignableUsers(false, 'partner/portal')
    expect(s.as()).toEqual(['bob-work', 'bob-work', 'alice', 'alice', 'alice', 'alice'])
    expect(s.calls[0].args.join(' ')).toContain('repos/globex/app/issues/7/assignees')
    expect(s.calls[1].args.join(' ')).toContain('repos/globex/app/assignees')
  })
})
