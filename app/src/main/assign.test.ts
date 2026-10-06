import { describe, expect, it } from 'vitest'
import type { AssignRequest } from '@shared/ipc'
import type { Proposal } from '@shared/types'
import { assignNow, inRepoFolder, retryHeld, startAssign, type AssignCli } from './assign'

function fakeCli(over: Partial<Record<keyof AssignCli, unknown>> = {}) {
  const calls: string[] = []
  const ok = (m = 'ok') => ({ ok: true, message: m })
  const cli: AssignCli = {
    approve: async (ids) => (calls.push(`approve ${ids}`), (over.approve as never) ?? ok()),
    reject: async (ids, note) => (calls.push(`reject ${ids}${note ? ` (${note})` : ''}`), ok()),
    spawn: async (id) => (calls.push(`spawn ${id}`), (over.spawn as never) ?? ok()),
    spawnHeld: async (id) => (calls.push(`spawnHeld ${id}`), (over.spawnHeld as never) ?? ok()),
    addAssign: async (a) => (calls.push(`add ${a.name}${a.model ? ` --model ${a.model}` : ''}${a.account ? ` --account ${a.account}` : ''}`), (over.addAssign as never) ?? { ok: true, id: 30 }),
  }
  return { cli, calls }
}

const req = (p: Partial<AssignRequest>): AssignRequest => ({ issue: 9, name: '9-x', cwd: '/w', prompt: 'P', proposalId: null, edited: false, approved: false, ...p })

describe('startAssign', () => {
  it('a chosen account makes a new proposal with it; the fallback goes only on new proposals', async () => {
    const f = fakeCli()
    await startAssign(f.cli, req({ proposalId: 20, account: 'bob-work' }))
    expect(f.calls).toEqual(['add 9-x --account bob-work', 'approve 30', 'reject 20', 'spawn 30'])
    const g = fakeCli()
    await startAssign(g.cli, req({ proposalId: 20 }), 0, 'alice')
    expect(g.calls).toEqual(['approve 20', 'spawn 20'])
    const h = fakeCli()
    await startAssign(h.cli, req({}), 0, 'alice')
    expect(h.calls[0]).toBe('add 9-x --account alice')
  })
  it("reuses master's unchanged proposal: approve, then spawn", async () => {
    const f = fakeCli()
    expect((await startAssign(f.cli, req({ proposalId: 20 }))).ok).toBe(true)
    expect(f.calls).toEqual(['approve 20', 'spawn 20'])
  })
  it('an already approved proposal is only spawned', async () => {
    const f = fakeCli()
    await startAssign(f.cli, req({ proposalId: 20, approved: true }))
    expect(f.calls).toEqual(['spawn 20'])
  })
  it('an edited proposal: add, approve, reject the old one, spawn the new one', async () => {
    const f = fakeCli()
    await startAssign(f.cli, req({ proposalId: 20, edited: true }))
    expect(f.calls).toEqual(['add 9-x', 'approve 30', 'reject 20', 'spawn 30'])
  })
  it('a failed approve rejects the proposal it just added and does not spawn', async () => {
    const f = fakeCli({ approve: { ok: false, message: 'locked' } })
    expect(await startAssign(f.cli, req({}))).toEqual({ ok: false, message: 'locked' })
    expect(f.calls).toEqual(['add 9-x', 'approve 30', 'reject 30'])
  })
  it('master spawning it first counts as started', async () => {
    const f = fakeCli({ spawn: { ok: false, message: '30: proposal 30 is sent, not approved' } })
    expect((await startAssign(f.cli, req({}))).ok).toBe(true)
  })
  it('a real spawn failure is reported', async () => {
    const f = fakeCli({ spawn: { ok: false, message: 'proposal 30: cwd does not exist: /w' } })
    expect(await startAssign(f.cli, req({}))).toEqual({ ok: false, message: 'proposal 30: cwd does not exist: /w', proposalId: 30 })
  })
  it("a chosen model replaces master's proposal with one that carries it", async () => {
    const f = fakeCli()
    await startAssign(f.cli, req({ proposalId: 20, approved: true, model: 'sonnet' }))
    expect(f.calls).toEqual(['add 9-x --model sonnet', 'approve 30', 'reject 20', 'spawn 30'])
  })
  it('retrying a held proposal only spawns it again', async () => {
    const f = fakeCli()
    await startAssign(f.cli, req({ proposalId: 30, approved: true }))
    expect(f.calls).toEqual(['spawn 30'])
  })
  it('a retry starts the same held proposal once, whatever model or account the first start named', async () => {
    const f = fakeCli()
    const r = await startAssign(f.cli, req({ proposalId: 30, retry: true, edited: true, approved: true, model: 'sonnet', account: 'bob-work' }), 0, 'alice')
    expect(f.calls).toEqual(['spawnHeld 30'])
    expect(r).toEqual({ ok: true, message: 'started proposal 30', proposalId: 30 })
  })
  it('a retry never spawns a proposal held for another reason: the CLI decides, and its refusal is passed on', async () => {
    // What a browser could send for any held proposal: only the guarded spawn is ever asked.
    const f = fakeCli({ spawnHeld: { ok: false, message: 'proposal 30 is not a start held because Claude Code refused its folder' } })
    expect(await startAssign(f.cli, req({ proposalId: 30, retry: true }))).toEqual({ ok: false, message: 'proposal 30 is not a start held because Claude Code refused its folder', proposalId: 30 })
    expect(f.calls).toEqual(['spawnHeld 30'])
  })
  it('a retry while the ticket already has a session closes the held start and starts nothing', async () => {
    const f = fakeCli()
    const r = await startAssign(f.cli, req({ proposalId: 30, retry: true }), 0, null, () => '9-x')
    expect(f.calls).toEqual(['reject 30 (a session named 9-x is already running; this held start was closed)'])
    // Said on the "did not start" tab: there is no new session for it to wait for.
    expect(r).toEqual({ ok: false, message: 'a session named 9-x is already running; this held start was closed', proposalId: 30 })
  })
  it('a retry with no proposal yet starts over', async () => {
    const f = fakeCli()
    await startAssign(f.cli, req({ retry: true }))
    expect(f.calls).toEqual(['add 9-x', 'approve 30', 'spawn 30'])
  })
})

describe('retryHeld', () => {
  const held = (over: Partial<Proposal> = {}): Proposal => ({ id: 85, kind: 'ASSIGN', issue: 9, status: 'held', heldFor: 'trust', summary: 's', message: 'm', note: 'Workspace not trusted.', target: { spawn: { name: '9-x', cwd: 'code/api', prompt: 'go', account: 'alice' } }, ...over })
  const deps = (owner: string | null = null) => {
    const expected: string[] = []
    return { expected, d: { expect: (n: string, l: string) => void expected.push(`${n} ${l}`), owner: () => owner } }
  }
  it('starts the held proposal itself, once, through the guarded spawn, and records its account', async () => {
    const f = fakeCli()
    const x = deps()
    expect(await retryHeld(f.cli, held(), x.d)).toEqual({ ok: true, message: 'started 9-x' })
    expect(f.calls).toEqual(['spawnHeld 85'])
    expect(x.expected).toEqual(['9-x alice'])
  })
  it('the ticket was started again in the meantime: the held start is closed, no second session', async () => {
    const f = fakeCli()
    const x = deps('9-x')
    expect(await retryHeld(f.cli, held(), x.d)).toEqual({ ok: true, message: 'a session named 9-x is already running; this held start was closed' })
    expect(f.calls).toEqual(['reject 85 (a session named 9-x is already running; this held start was closed)'])
    expect(x.expected).toEqual([])
  })
  it('a proposal master spawned in the meantime counts as started', async () => {
    const f = fakeCli({ spawnHeld: { ok: false, message: 'proposal 85 is sent, not approved' } })
    expect((await retryHeld(f.cli, held(), deps().d)).ok).toBe(true)
  })
  it('a failure is passed on and nothing is recorded', async () => {
    const f = fakeCli({ spawnHeld: { ok: false, message: 'proposal 85: Workspace not trusted.' } })
    const x = deps()
    expect(await retryHeld(f.cli, held(), x.d)).toEqual({ ok: false, message: 'proposal 85: Workspace not trusted.' })
    expect(x.expected).toEqual([])
  })
  it('only a start held for trust is started again', async () => {
    const f = fakeCli()
    for (const p of [held({ status: 'sent' }), held({ target: { session: '9-x' } }), held({ heldFor: undefined, note: 'claude --bg did not return within 60 s and may still have started a session' })])
      expect((await retryHeld(f.cli, p, deps().d)).ok).toBe(false)
    expect(f.calls).toEqual([])
  })
})

describe('assignNow', () => {
  const multi = (proposalAccount: string | null = null) => {
    const expected: string[] = []
    return {
      expected,
      acc: {
        settings: async (a: string | null | undefined) => ({ ok: true as const, args: ['--settings', `/f/${a || 'alice'}`], account: a || 'alice' }),
        proposalAccount: () => proposalAccount,
        expect: (name: string, login: string) => expected.push(`${name} ${login}`),
      },
    }
  }

  it("reuses master's proposal when it already names the account, and records it", async () => {
    const f = fakeCli()
    const m = multi('alice')
    expect((await assignNow(f.cli, req({ proposalId: 20 }), m.acc, 0)).ok).toBe(true)
    expect(f.calls).toEqual(['approve 20', 'spawn 20'])
    expect(m.expected).toEqual(['9-x alice'])
  })
  it("a reused proposal without the account (it would start as gh's active one) becomes a new one carrying it", async () => {
    const f = fakeCli()
    await assignNow(f.cli, req({ proposalId: 20, approved: true }), multi(null).acc, 0)
    expect(f.calls).toEqual(['add 9-x --account alice', 'approve 30', 'reject 20', 'spawn 30'])
    const g = fakeCli()
    await assignNow(g.cli, req({ proposalId: 20, account: 'bob-work' }), multi('alice').acc, 0)
    expect(g.calls[0]).toBe('add 9-x --account bob-work')
  })
  it('a retry spawns the held proposal even when the state has not seen it yet, and records the account', async () => {
    const f = fakeCli()
    const m = multi(null)
    expect((await assignNow(f.cli, req({ proposalId: 30, retry: true, approved: true }), m.acc, 0)).ok).toBe(true)
    expect(f.calls).toEqual(['spawnHeld 30'])
    expect(m.expected).toEqual(['9-x alice'])
  })
  it('one account: the account is dropped and nothing is recorded', async () => {
    const f = fakeCli()
    const m = multi()
    const single = { ...m.acc, settings: async () => ({ ok: true as const, args: [], account: null }) }
    await assignNow(f.cli, req({ proposalId: 20, account: 'bob-work' }), single, 0)
    expect(f.calls).toEqual(['approve 20', 'spawn 20'])
    await assignNow(f.cli, req({ account: 'bob-work' }), single, 0)
    expect(f.calls[2]).toBe('add 9-x')
    expect(m.expected).toEqual([])
  })
  it('an account that needs to log in again is refused before anything is added', async () => {
    const f = fakeCli()
    const m = multi()
    const bad = { ...m.acc, settings: async () => ({ ok: false as const, message: 'GitHub account bob-work needs to log in again' }) }
    expect(await assignNow(f.cli, req({ account: 'bob-work' }), bad, 0)).toEqual({ ok: false, message: 'GitHub account bob-work needs to log in again' })
    expect(f.calls).toEqual([])
  })
})

describe('inRepoFolder', () => {
  const at = (r: unknown) => ({ checkout: async (repo: string) => (asked.push(repo), r as never) })
  let asked: string[] = []
  it('a request that names a repository starts where the CLI says: its checkout, else its account\'s workspace', async () => {
    asked = []
    const r = await inRepoFolder(at({ ok: true, cwd: '/code/globex/app', workspace: '/code/globex', found: true }), req({ kind: 'PRREVIEW', cwdRepo: 'globex/app' }))
    expect([r.cwd, asked]).toEqual(['/code/globex/app', ['globex/app']])
    expect((await inRepoFolder(at({ ok: true, cwd: '/code/globex', workspace: '/code/globex', found: false }), req({ cwdRepo: 'globex/app' }))).cwd).toBe('/code/globex')
  })
  it('keeps the given folder when the CLI cannot say, and never asks without a repository', async () => {
    asked = []
    expect((await inRepoFolder(at({ ok: false, message: 'x' }), req({ cwdRepo: 'globex/app' }))).cwd).toBe('/w')
    expect((await inRepoFolder(at({ ok: true, cwd: '/x', workspace: '/x', found: true }), req({}))).cwd).toBe('/w')
    expect((await inRepoFolder(at({ ok: true, cwd: '/x', workspace: '/x', found: true }), req({ cwdRepo: 'not a repo' }))).cwd).toBe('/w')
    expect(asked).toEqual(['globex/app'])
  })
})
