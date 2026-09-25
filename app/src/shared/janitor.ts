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
  /** Worktree HEAD commit. */
  head?: string | null
  /** The branch's pull request on GitHub, when one was found. */
  pr?: BranchPr | null
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export interface BranchPr {
  number: number
  state: PrState
  url: string
  /** Last commit of the PR's branch as GitHub has it. */
  headOid: string
}

/** `owner/repo` from an origin URL (https, ssh, or an ssh host alias like github.com-work). */
export function repoSlug(remoteUrl: string): string | null {
  const m = /github\.com[^:/]*[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * The PR for a branch from `gh pr list --state all --json number,state,headRefName,headRefOid,url`.
 * An open PR wins (work continues on the branch), then the newest merged, then the newest closed.
 */
export function prForBranch(list: unknown, branch: string | null): BranchPr | null {
  if (!branch || !Array.isArray(list)) return null
  const prs: BranchPr[] = list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && (p as Record<string, unknown>).headRefName === branch)
    .filter((p) => typeof p.number === 'number' && (p.state === 'OPEN' || p.state === 'MERGED' || p.state === 'CLOSED'))
    .map((p) => ({ number: p.number as number, state: p.state as PrState, url: String(p.url ?? ''), headOid: String(p.headRefOid ?? '') }))
  const rank = (st: PrState) => ['OPEN', 'MERGED', 'CLOSED'].indexOf(st)
  return prs.sort((a, b) => rank(a.state) - rank(b.state) || b.number - a.number)[0] ?? null
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
  // A squash or rebase merge leaves the branch unmerged in git; GitHub knows. Only when the worktree
  // still sits on the commit that was merged: later commits would be work the PR never had.
  if (w.pr?.state === 'MERGED' && w.head && w.head === w.pr.headOid) return { cls: 'SAFE', reason: `PR #${w.pr.number} merged` }
  if (w.merged) return { cls: 'SAFE', reason: 'merged into the default branch' }
  if (!w.branch && w.orphanCommits === 0) return { cls: 'SAFE', reason: 'detached, every commit is on a branch' }
  if (w.branch && w.pushed) return { cls: 'PUSHED', reason: 'unmerged, but the branch is on origin' }
  return { cls: 'UNPUSHED', reason: w.branch ? 'commits on no remote and not merged' : `${w.orphanCommits} orphaned commit(s)` }
}

/** What Clean up removes: clean, not in use, and its PR merged. */
export function isCleanupTarget(w: { cls: WorktreeClass; pr?: BranchPr | null }): boolean {
  return w.cls === 'SAFE' && w.pr?.state === 'MERGED'
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
