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
    const r = await new GitHub(f.run).assign({ repo: null, number: 989 }, 'alice', ['rahul', 'zoe'])
    expect(r.ok).toBe(true)
    expect(f.calls).toEqual([
      ['api', '-X', 'DELETE', 'repos/acme/tracker/issues/989/assignees', '-f', 'assignees[]=rahul', '-f', 'assignees[]=zoe'],
      ['api', '-X', 'POST', 'repos/acme/tracker/issues/989/assignees', '-f', 'assignees[]=alice'],
    ])
  })
  it('skips calls that change nothing, and refuses bad input', async () => {
    const f = fake(() => ({}))
    await new GitHub(f.run).assign({ repo: null, number: 989 }, 'rahul', ['rahul'])
    expect(f.calls).toEqual([])
    expect((await new GitHub(f.run).assign({ repo: null, number: 989 }, 'bad user;rm', [])).ok).toBe(false)
    expect((await new GitHub(f.run).assign({ repo: null, number: -1 }, 'rahul', [])).ok).toBe(false)
  })
  it('reports a failed removal and does not add', async () => {
    const f = fake((a) => (a.includes('DELETE') ? { code: 1, stdout: 'Not Found' } : {}))
    const r = await new GitHub(f.run).assign({ repo: null, number: 1 }, 'x', ['y'])
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
  it('reads the assignable users of the primary issue repo, or of the repository named', async () => {
    const f = fake(() => ({ stdout: 'zoe\n' }))
    const gh = new GitHub(f.run)
    await gh.assignableUsers()
    expect(await gh.assignableUsers(false, 'globex/app')).toEqual(['zoe'])
    const paths = f.calls.map((c) => c.find((a) => a.includes('/assignees')))
    expect(paths[1]).toBe('repos/globex/app/assignees?per_page=100')
    expect(paths[0]).not.toBe(paths[1])
    expect(paths[0]).toMatch(/^repos\/[^/]+\/[^/]+\/assignees\?per_page=100$/)
    expect(f.calls.every((c) => !c.includes('-X'))).toBe(true) // a read
  })
})

describe('GitHub.subIssues', () => {
  it("reads the issue's sub-issues in one page, as a read", async () => {
    const f = fake(() => ({ stdout: JSON.stringify({ number: 3, title: 'Part', state: 'open', url: 'https://github.com/globex/app/issues/3', repo: 'globex/app' }) + '\n' }))
    const r = await new GitHub(f.run).subIssues({ repo: 'globex/app', number: 12 })
    expect(r).toEqual({ ok: true, subIssues: [{ repo: 'globex/app', number: 3, title: 'Part', state: 'open', url: 'https://github.com/globex/app/issues/3' }] })
    expect(f.calls[0].slice(0, 2)).toEqual(['api', 'repos/globex/app/issues/12/sub_issues?per_page=100'])
    expect(f.calls[0]).not.toContain('-X')
  })
  it('reports a failed read', async () => {
    const f = fake(() => ({ code: 1, stdout: 'Not Found' }))
    expect(await new GitHub(f.run).subIssues({ repo: null, number: 1 })).toEqual({ ok: false, message: 'Not Found' })
  })
})

describe('GitHub.teamPrPages', () => {
  const empty = JSON.stringify({ data: { search: { nodes: [], pageInfo: { hasNextPage: false } } } })
  it("searches the given owner as its type (an account's), else the config's owner as before", async () => {
    const f = fake(() => ({ stdout: empty }))
    const NOW = Date.parse('2026-09-25T12:00:00Z')
    expect((await new GitHub(f.run).teamPrPages('globex', NOW, false, 'user')).ok).toBe(true)
    expect(f.calls.map((a) => a.find((x) => x.startsWith('q='))?.split(' ')[0])).toEqual(['q=user:globex', 'q=user:globex'])
    f.calls.length = 0
    await new GitHub(f.run).teamPrPages(undefined, NOW)
    expect(f.calls.map((a) => a.find((x) => x.startsWith('q='))?.split(' ')[0])).toEqual(['q=org:acme', 'q=org:acme'])
  })
})
