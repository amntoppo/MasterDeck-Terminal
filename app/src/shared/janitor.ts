export interface WorktreeInfo {
  repo: string
  path: string
  branch: string | null
  dirtyFiles: number
  /** Branch (or detached HEAD) fully merged into the default branch. */
  merged: boolean
  /** Branch exists on origin. */
  pushed: boolean
  /** Commits not reachable from any branch (detached HEAD). */
  orphanCommits: number
  lastCommitAt: number | null
}

export type WorktreeClass = 'SAFE' | 'PUSHED' | 'DIRTY' | 'UNPUSHED' | 'IN USE'

/**
 * The worktree-janitor skill's classes. IN USE (a live session's cwd or current dir is inside it)
 * wins; then DIRTY (uncommitted changes, never auto-removed); SAFE (merged, or detached with every
 * commit on a branch); PUSHED (branch on origin); else UNPUSHED.
 */
export function classifyWorktree(w: WorktreeInfo, liveDirs: string[]): { cls: WorktreeClass; reason: string } {
  const inside = (d: string) => d === w.path || d.startsWith(w.path.endsWith('/') ? w.path : `${w.path}/`)
  if (liveDirs.some(inside)) return { cls: 'IN USE', reason: 'a live session works here' }
  if (w.dirtyFiles < 0) return { cls: 'DIRTY', reason: 'git status failed; treated as dirty' }
  if (w.dirtyFiles > 0) return { cls: 'DIRTY', reason: `${w.dirtyFiles} uncommitted file${w.dirtyFiles === 1 ? '' : 's'}` }
  if (w.merged) return { cls: 'SAFE', reason: 'merged into the default branch' }
  if (!w.branch && w.orphanCommits === 0) return { cls: 'SAFE', reason: 'detached, every commit is on a branch' }
  if (w.branch && w.pushed) return { cls: 'PUSHED', reason: 'unmerged, but the branch is on origin' }
  return { cls: 'UNPUSHED', reason: w.branch ? 'commits on no remote and not merged' : `${w.orphanCommits} orphaned commit(s)` }
}

/** Whether Remove needs the user to type the worktree name first. */
export function needsTypedConfirm(cls: WorktreeClass): boolean {
  return cls === 'DIRTY' || cls === 'UNPUSHED'
}

/** `git worktree list --porcelain` → [{path, branch}] (branch null when detached). */
export function parseWorktreeList(text: string): { path: string; branch: string | null; head: string | null }[] {
  const out: { path: string; branch: string | null; head: string | null }[] = []
  for (const block of text.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null
    const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] ?? null
    out.push({ path, branch: ref, head })
  }
  return out
}
