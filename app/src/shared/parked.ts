/**
 * A ticket or PR review session that MasterDeck started in a folder that is not a workspace: most
 * often its repository's main checkout, on whatever branch was left checked out there. `master
 * spawn` records it (`parked-sessions.json`: { [background id, or "name:<session name>"]: … }).
 * That branch, and its open PR, belong to someone else's work, so the session is not given them.
 */
export interface Parked {
  /** The folder it was started in. */
  dir: string
  /** The branch that folder was on at the start; '' for a detached HEAD or no checkout. */
  branch: string
  /** A PR review session: it reads a diff and never has a branch of its own. */
  review: boolean
}

type Obj = Record<string, unknown>

export function parseParked(raw: unknown): Record<string, Parked> {
  const out: Record<string, Parked> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Obj)) {
    const p = v && typeof v === 'object' ? (v as Obj) : null
    if (p && typeof p.dir === 'string' && typeof p.branch === 'string') out[k] = { dir: p.dir, branch: p.branch, review: p.review === true }
  }
  return out
}

/** A session's record: by its background id (`Session.key`), else by the name it was started with. */
export function parkedFor(m: Record<string, Parked>, s: { key: string; name: string }): Parked | null {
  return m[s.key] ?? m[`name:${s.name}`] ?? null
}

const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/**
 * Is the branch of a session's folder the session's own: may it be given that branch's PR, and
 * may a ticket link record the branch?
 * - Never in a workspace (master's or an account's): every session shares it.
 * - No record (a session started by hand, or before this version): yes, as always. Working on a
 *   feature branch in a main checkout is a normal way to work.
 * - Parked by MasterDeck: not while it still sits in a main checkout on the branch it found
 *   there. Yes once it works in a linked worktree, or the checkout is on another branch (it
 *   switched or made its own). A PR review session: never.
 */
export function ownsFolderBranch(o: { dir: string; workspaces: string[]; linked: boolean; branch: string | null; parked: Parked | null }): boolean {
  if (o.workspaces.some((w) => w && bare(w) === bare(o.dir))) return false
  if (!o.parked) return true
  if (o.parked.review) return false
  return o.linked || (o.branch ?? '') !== o.parked.branch
}
