import { describe, expect, it } from 'vitest'
import type { AssignRequest } from '@shared/ipc'
import { startAssign, type AssignCli } from './assign'

function fakeCli(over: Partial<Record<keyof AssignCli, unknown>> = {}) {
  const calls: string[] = []
  const ok = (m = 'ok') => ({ ok: true, message: m })
  const cli: AssignCli = {
    approve: async (ids) => (calls.push(`approve ${ids}`), (over.approve as never) ?? ok()),
    reject: async (ids) => (calls.push(`reject ${ids}`), ok()),
    spawn: async (id) => (calls.push(`spawn ${id}`), (over.spawn as never) ?? ok()),
    addAssign: async (a) => (calls.push(`add ${a.name}`), (over.addAssign as never) ?? { ok: true, id: 30 }),
  }
  return { cli, calls }
}

const req = (p: Partial<AssignRequest>): AssignRequest => ({ issue: 9, name: '9-x', cwd: '/w', prompt: 'P', proposalId: null, edited: false, approved: false, ...p })

describe('startAssign', () => {
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
  it('retrying a held proposal only spawns it again', async () => {
    const f = fakeCli()
    await startAssign(f.cli, req({ proposalId: 30, approved: true }))
    expect(f.calls).toEqual(['spawn 30'])
  })
})
