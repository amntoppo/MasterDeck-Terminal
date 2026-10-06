import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRunner } from './run'
import { createWorktree, worktreeInfo } from './startWorktree'

const run = makeRunner(() => ({ ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }))
let top: string
let repo: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' }).toString()

beforeAll(() => {
  // .native: on Windows the temp folder comes as a short name (RUNNER~1) and git answers with the long one.
  top = realpathSync.native(mkdtempSync(join(tmpdir(), 'md-wt-')))
  repo = join(top, 'app')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'one')
  git(repo, 'branch', 'develop')
})
afterAll(() => rmSync(top, { recursive: true, force: true }))

describe('worktreeInfo', () => {
  it('names the main checkout, its branches and the branch to start from', async () => {
    const r = await worktreeInfo(run, repo)
    expect(r).toMatchObject({ ok: true, root: repo, base: 'main' })
    expect(r.ok && r.branches.sort()).toEqual(['develop', 'main'])
  })
  it('says a folder that is no checkout is none', async () => {
    const plain = join(top, 'plain')
    mkdirSync(plain)
    const r = await worktreeInfo(run, plain)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toContain('not a git checkout')
    expect((await worktreeInfo(run, join(top, 'gone'))).ok).toBe(false)
  })
})

describe('createWorktree', () => {
  it('makes the branch and the folder under .claude/worktrees, from the base', async () => {
    const r = await createWorktree(run, repo, 'feat/66-start', 'develop')
    const path = join(repo, '.claude', 'worktrees', 'feat-66-start')
    expect(r).toEqual({ ok: true, cwd: path, branch: 'feat/66-start', base: 'develop' })
    expect(git(path, 'branch', '--show-current').trim()).toBe('feat/66-start')
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    // The main checkout is where it was.
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
  })
  it('goes under the main checkout even when asked from inside a worktree', async () => {
    const r = await createWorktree(run, join(repo, '.claude', 'worktrees', 'feat-66-start'), '67-next', 'main')
    expect(r).toMatchObject({ ok: true, cwd: join(repo, '.claude', 'worktrees', '67-next') })
  })
  it('refuses a branch or folder that is there already, and changes nothing', async () => {
    const before = git(repo, 'worktree', 'list')
    const a = await createWorktree(run, repo, 'develop', 'main')
    expect(!a.ok && a.message).toContain('already exists')
    mkdirSync(join(repo, '.claude', 'worktrees', 'taken'), { recursive: true })
    const b = await createWorktree(run, repo, 'taken', 'main')
    expect(!b.ok && b.message).toContain('already exists')
    expect(git(repo, 'branch', '--list', 'taken').trim()).toBe('')
    expect(git(repo, 'worktree', 'list')).toBe(before)
  })
  it('refuses a base that is not there, a bad name and a folder that is no checkout', async () => {
    const a = await createWorktree(run, repo, '68-x', 'nope')
    expect(!a.ok && a.message).toContain('Base branch nope was not found')
    expect(git(repo, 'branch', '--list', '68-x').trim()).toBe('')
    for (const bad of ['-b', 'a..b', '', 5]) expect((await createWorktree(run, repo, bad, 'main')).ok).toBe(false)
    expect((await createWorktree(run, repo, '69-x', '--detach')).ok).toBe(false)
    expect((await createWorktree(run, top, '69-x', 'main')).ok).toBe(false)
  })
})
