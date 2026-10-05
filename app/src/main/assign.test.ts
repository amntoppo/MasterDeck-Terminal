import { describe, expect, it } from 'vitest'
import type { AssignRequest } from '@shared/ipc'
import { assignNow, inRepoFolder, startAssign, type AssignCli } from './assign'

function fakeCli(over: Partial<Record<keyof AssignCli, unknown>> = {}) {
  const calls: string[] = []
  const ok = (m = 'ok') => ({ ok: true, message: m })
  const cli: AssignCli = {
    approve: async (ids) => (calls.push(`approve ${ids}`), (over.approve as never) ?? ok()),
    reject: async (ids) => (calls.push(`reject ${ids}`), ok()),
    spawn: async (id) => (calls.push(`spawn ${id}`), (over.spawn as never) ?? ok()),
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
