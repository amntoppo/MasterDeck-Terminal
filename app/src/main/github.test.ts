import { describe, expect, it } from 'vitest'
import { GitHub } from './github'
import type { RunOpts, Runner } from './run'

function fake(reply: (args: string[]) => { code?: number; stdout?: string }) {
  const calls: string[][] = []
  const run: Runner = async (_cmd, args, _o?: RunOpts) => {
    calls.push(args)
    const r = reply(args)
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: '' }
  }
  return { run, calls }
}

describe('GitHub.assign', () => {
  it('removes the others, then adds the new assignee', async () => {
    const f = fake(() => ({}))
    const r = await new GitHub(f.run).assign(989, 'alice', ['rahul', 'zoe'])
    expect(r.ok).toBe(true)
    expect(f.calls).toEqual([
      ['api', '-X', 'DELETE', 'repos/acme/tracker/issues/989/assignees', '-f', 'assignees[]=rahul', '-f', 'assignees[]=zoe'],
      ['api', '-X', 'POST', 'repos/acme/tracker/issues/989/assignees', '-f', 'assignees[]=alice'],
    ])
  })
  it('skips calls that change nothing, and refuses bad input', async () => {
    const f = fake(() => ({}))
    await new GitHub(f.run).assign(989, 'rahul', ['rahul'])
    expect(f.calls).toEqual([])
    expect((await new GitHub(f.run).assign(989, 'bad user;rm', [])).ok).toBe(false)
    expect((await new GitHub(f.run).assign(-1, 'rahul', [])).ok).toBe(false)
  })
  it('reports a failed removal and does not add', async () => {
    const f = fake((a) => (a.includes('DELETE') ? { code: 1, stdout: 'Not Found' } : {}))
    const r = await new GitHub(f.run).assign(1, 'x', ['y'])
    expect(r.ok).toBe(false)
    expect(f.calls).toHaveLength(1)
  })
})

describe('GitHub users', () => {
  it('parses the paginated login list and my login', async () => {
    const f = fake((a) => (a[1] === 'user' ? { stdout: 'alice\n' } : { stdout: 'alice\nrahul\n\n' }))
    expect(await new GitHub(f.run).assignableUsers()).toEqual(['alice', 'rahul'])
    expect(await new GitHub(f.run).me()).toBe('alice')
  })
})
