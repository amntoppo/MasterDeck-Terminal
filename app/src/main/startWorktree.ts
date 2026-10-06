import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { baseError, branchError, worktreeDir } from '@shared/startOptions'
import type { Runner, RunResult } from './run'

export type WorktreeInfo =
  | { ok: true; /** The repository's main checkout (worktrees go under it). */ root: string; /** The branch a new worktree starts from unless another is named. */ base: string; branches: string[] }
  | { ok: false; message: string }

export type WorktreeMade = { ok: true; cwd: string; branch: string; base: string } | { ok: false; message: string }

const said = (r: RunResult): string => (r.stderr.trim() || r.stdout.trim() || `git exit ${r.code}`).split('\n').slice(-1)[0].replace(/^(fatal|error): /, '').slice(0, 300)

/** The main checkout a folder belongs to: the folder holding its repository's `.git` (also from inside a linked worktree). */
async function mainCheckout(run: Runner, cwd: string): Promise<{ ok: true; root: string } | { ok: false; message: string }> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd)) return { ok: false, message: 'That folder is not there.' }
  const r = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 10_000 })
  if (r.code !== 0) return { ok: false, message: `${cwd} is not a git checkout, so no worktree can be made there.` }
  const common = r.stdout.trim()
  if (basename(common) !== '.git') return { ok: false, message: `${cwd} is a bare repository; a worktree needs a checkout.` }
  return { ok: true, root: resolve(dirname(common)) }
}

/**
 * What the Start dialog needs to offer a worktree in `cwd`: the main checkout, its branches and
 * the default base. The base is the repository's default branch as it is on this machine (the
 * local branch `origin/HEAD` names, else that remote branch), else the branch checked out now.
 * Reads only; nothing is fetched.
 */
export async function worktreeInfo(run: Runner, cwd: string): Promise<WorktreeInfo> {
  const m = await mainCheckout(run, cwd)
  if (!m.ok) return m
  const git = (args: string[]) => run('git', ['-C', m.root, ...args], { timeoutMs: 10_000 })
  const refs = await git(['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', '--count=300', 'refs/heads', 'refs/remotes'])
  const branches = refs.stdout.split('\n').map((s) => s.trim()).filter((b) => b && !/(^|\/)HEAD$/.test(b) && !baseError(b))
  const head = (await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim()
  const local = head.startsWith('origin/') ? head.slice(7) : ''
  const current = (await git(['branch', '--show-current'])).stdout.trim()
  const base = (local && branches.includes(local) ? local : '') || (head && branches.includes(head) ? head : '') || current || 'HEAD'
  return { ok: true, root: m.root, base, branches }
}

/**
 * `git worktree add -b <branch> <root>/.claude/worktrees/<branch> <base>`: the ticket's own
 * working copy, where Claude Code keeps worktrees too. Nothing is overwritten or reused: a branch
 * or folder of that name already there is an error, said before git is asked to change anything.
 */
export async function createWorktree(run: Runner, cwd: string, branch: unknown, base: unknown): Promise<WorktreeMade> {
  if (typeof branch !== 'string' || typeof base !== 'string') return { ok: false, message: 'bad worktree request' }
  const bad = branchError(branch) ?? (base === 'HEAD' ? null : baseError(base))
  if (bad) return { ok: false, message: bad }
  const m = await mainCheckout(run, cwd)
  if (!m.ok) return m
  const git = (args: string[], timeoutMs = 10_000) => run('git', ['-C', m.root, ...args], { timeoutMs })
  if ((await git(['check-ref-format', '--branch', branch])).code !== 0) return { ok: false, message: `git does not take "${branch}" as a branch name.` }
  if ((await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0)
    return { ok: false, message: `A branch named ${branch} already exists in ${m.root}. Type another branch name.` }
  const path = join(m.root, '.claude', 'worktrees', worktreeDir(branch))
  if (existsSync(path)) return { ok: false, message: `${path} already exists. Type another branch name.` }
  if ((await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).code !== 0)
    return { ok: false, message: `Base branch ${base} was not found in ${m.root}.` }
  const r = await git(['worktree', 'add', '-b', branch, path, base], 120_000)
  if (r.code !== 0) return { ok: false, message: `git could not make the worktree: ${said(r)}` }
  return { ok: true, cwd: path, branch, base }
}
