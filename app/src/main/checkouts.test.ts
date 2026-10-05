import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandHome, listCheckouts, workspaceRepos } from './checkouts'
import { Ops } from './ops'
import type { Paths } from './paths'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'co-')))
const repo = (d: string) => (mkdirSync(join(d, '.git'), { recursive: true }), d)
const worktree = (d: string) => (mkdirSync(d, { recursive: true }), writeFileSync(join(d, '.git'), 'gitdir: /elsewhere\n'), d)

describe('listCheckouts (the resolver\'s depth rule)', () => {
  it('the workspace, its sub-folders, and one level below the plain ones', () => {
    const d = tmp()
    repo(d)
    repo(join(d, 'api'))
    repo(join(d, 'acme', 'web'))
    repo(join(d, 'a', 'b', 'deep'))
    repo(join(d, 'api', 'vendor'))
    repo(join(d, '.hidden'))
    worktree(join(d, 'wt'))
    repo(join(d, 'wt', 'inner'))
    expect(listCheckouts(d)).toEqual([d, join(d, 'api'), join(d, 'acme', 'web')])
  })
  it('never follows a link out of the workspace, and stops at the limit', () => {
    const d = tmp()
    const out = repo(join(tmp(), 'outside'))
    symlinkSync(out, join(d, 'linked'))
    for (const n of ['a', 'b', 'c']) repo(join(d, n))
    expect(listCheckouts(d)).toEqual([join(d, 'a'), join(d, 'b'), join(d, 'c')])
    expect(listCheckouts(d, 3)).toEqual([join(d, 'a'), join(d, 'b')])
    expect(listCheckouts(join(d, 'gone'))).toEqual([])
  })
})

describe('workspaceRepos', () => {
  it('one workspace with its repos directly inside: exactly the list as it was', () => {
    const d = tmp()
    repo(join(d, 'api'))
    worktree(join(d, 'api-wt'))
    mkdirSync(join(d, 'notes'))
    expect(workspaceRepos(d, [])).toEqual([join(d, 'api'), join(d, 'api-wt')])
    // A workspace that is a repo itself: its siblings, as before.
    const w = repo(join(d, 'api'))
    expect(workspaceRepos(w, [])).toEqual([join(d, 'api'), join(d, 'api-wt')])
  })
  it('adds the checkouts one level down and every other account\'s workspace, each once', () => {
    const d = tmp()
    repo(join(d, 'acme', 'api'))
    repo(join(d, 'acme', 'team', 'web'))
    repo(join(d, 'globex', 'app'))
    repo(join(d, 'globex', 'org', 'site'))
    expect(workspaceRepos(join(d, 'acme'), [join(d, 'globex'), join(d, 'globex'), join(d, 'acme'), '', join(d, 'gone')])).toEqual([
      join(d, 'acme', 'api'),
      join(d, 'acme', 'team', 'web'),
      join(d, 'globex', 'app'),
      join(d, 'globex', 'org', 'site'),
    ])
  })
  it('expands ~ as the CLI does', () => {
    expect(expandHome('~/code')).toBe(join(homedir(), 'code'))
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('/code/~x')).toBe('/code/~x')
  })
})

describe('Ops.repos', () => {
  it('lists every account\'s workspace, so Janitor and Remove reach worktrees made there', async () => {
    const d = tmp()
    repo(join(d, 'acme', 'api'))
    const app = repo(join(d, 'globex', 'app'))
    const run = async () => ({ code: 0, stdout: '', stderr: '' })
    const one = new Ops(run, { masterWorkspace: join(d, 'acme') } as Paths, () => 'claude')
    expect(one.repos()).toEqual([join(d, 'acme', 'api')])
    const two = new Ops(run, { masterWorkspace: join(d, 'acme') } as Paths, () => 'claude', undefined, () => [], () => [join(d, 'globex')])
    expect(two.repos()).toEqual([join(d, 'acme', 'api'), app])
    mkdirSync(join(app, '.claude', 'worktrees', '7-x'), { recursive: true })
    const no = await one.removeWorktree(app, join(app, '.claude', 'worktrees', '7-x'), false, [])
    expect(no.message).toBe('not one of the workspace repos')
    const yes = await two.removeWorktree(app, join(app, '.claude', 'worktrees', '7-x'), false, [])
    expect(yes.message).toBe('git does not list that worktree') // past the repo check
  })
})
