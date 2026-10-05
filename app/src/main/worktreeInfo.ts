import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { SessionWorktree } from '@shared/worktrees'

/**
 * A linked git worktree at `path`: its `.git` is a file pointing into the main checkout's
 * `.git/worktrees/<name>`. Null for anything else (gone, a plain folder, a main checkout).
 */
export function linkedWorktree(path: string): SessionWorktree | null {
  try {
    const dotGit = join(path, '.git')
    if (!statSync(dotGit).isFile()) return null
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!m) return null
    const gitdir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(path, m[1].trim())
    // <main>/.git/worktrees/<name> → <main>
    const main = dirname(dirname(dirname(gitdir)))
    let branch: string | null = null
    try {
      const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim()
      branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : null
    } catch {
      // HEAD unreadable: no branch shown
    }
    return { path, repo: basename(main), branch }
  } catch {
    return null
  }
}

/**
 * Is `dir` inside a linked git worktree: the nearest `.git` above it (or in it) is a file. False
 * for a main checkout (its `.git` is a folder), a folder in no repository, and a folder that is gone.
 */
export function inLinkedWorktree(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false
  for (let d = resolve(dir); ; d = dirname(d)) {
    try {
      return statSync(join(d, '.git')).isFile()
    } catch {
      if (dirname(d) === d) return false
    }
  }
}

/**
 * May a session in `dir` be given the PR of the branch that folder is on? Only when it works in a
 * linked worktree: that branch is its own. A main checkout is shared: a new ticket session sits
 * there until it makes its worktree, a PR review session stays there, and the branch (with its
 * open PR) is whatever someone left checked out. The same goes for a workspace, master's included.
 */
export function takesBranchPr(dir: string | undefined | null, masterWorkspace: string): boolean {
  return !!dir && resolve(dir) !== resolve(masterWorkspace) && inLinkedWorktree(dir)
}
