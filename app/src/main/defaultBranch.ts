import type { Runner } from './run'

export interface BranchPrep {
  ok: boolean
  /** What was done, for a toast; null when nothing needed doing. */
  message: string | null
}

const GIT_MS = 30_000

/** The remote's default branch (origin/HEAD), else main, master or dev, whichever exists. */
export async function defaultBranch(run: Runner, dir: string): Promise<string | null> {
  const head = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, timeoutMs: GIT_MS })
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '')
  for (const b of ['main', 'master', 'dev']) {
    const r = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { cwd: dir, timeoutMs: GIT_MS })
    if (r.code === 0) return b
  }
  return null
}

/**
 * Put a git checkout on its default branch before a new shell opens there (+ Shell), so a session
 * started in it starts from main (or dev), not whatever branch the checkout was left on. Changes on
 * the old branch are stashed, untracked files included, under a message naming the branch. Then
 * it fast-forwards from origin. A folder that is not a repo root is left alone.
 */
export async function toDefaultBranch(run: Runner, dir: string, today = new Date().toISOString().slice(0, 10)): Promise<BranchPrep> {
  const git = (...args: string[]) => run('git', args, { cwd: dir, timeoutMs: GIT_MS })
  const top = await git('rev-parse', '--show-toplevel')
  if (top.code !== 0 || !sameDir(top.stdout.trim(), dir)) return { ok: true, message: null }
  const target = await defaultBranch(run, dir)
  if (!target) return { ok: true, message: null }
  const current = (await git('branch', '--show-current')).stdout.trim()
  const notes: string[] = []
  if (current !== target) {
    const dirty = (await git('status', '--porcelain')).stdout.trim() !== ''
    let stashed = false
    if (dirty) {
      const msg = `masterdeck: ${current || 'detached HEAD'} before switching to ${target} (${today})`
      const s = await git('stash', 'push', '--include-untracked', '-m', msg)
      if (s.code !== 0) return { ok: false, message: `Stayed on ${current}: could not stash its changes (${firstLine(s.stderr)})` }
      stashed = true
      notes.push(`stashed the changes on ${current} ("${msg}"; git stash list)`)
    }
    const sw = await git('switch', target)
    if (sw.code !== 0) {
      if (stashed) await git('stash', 'pop')
      return { ok: false, message: `Stayed on ${current}: could not switch to ${target} (${firstLine(sw.stderr)})` }
    }
    notes.unshift(`switched ${dirName(dir)} from ${current || 'a detached HEAD'} to ${target}`)
  }
  const pull = await git('pull', '--ff-only')
  if (pull.code !== 0) notes.push(`could not fast-forward ${target} (${firstLine(pull.stderr)})`)
  else if (!/Already up to date/i.test(pull.stdout)) notes.push(`updated ${target} from origin`)
  return { ok: true, message: notes.length ? cap(notes.join('; ')) : null }
}

const firstLine = (s: string): string => s.trim().split('\n')[0]?.slice(0, 160) || 'no details'
const dirName = (d: string): string => d.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || d
const sameDir = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '')
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
