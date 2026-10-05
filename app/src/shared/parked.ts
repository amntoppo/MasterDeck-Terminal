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
  /** When it was started (ms); absent in a record that carries no usable time. */
  at?: number
}

type Obj = Record<string, unknown>

export function parseParked(raw: unknown): Record<string, Parked> {
  const out: Record<string, Parked> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Obj)) {
    const p = v && typeof v === 'object' ? (v as Obj) : null
    if (!p || typeof p.dir !== 'string' || typeof p.branch !== 'string') continue
    const at = typeof p.at === 'string' ? Date.parse(p.at) : NaN
    out[k] = { dir: p.dir, branch: p.branch, review: p.review === true, ...(Number.isFinite(at) ? { at } : {}) }
  }
  return out
}

const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
const inside = (dir: string, root: string) => bare(dir) === bare(root) || bare(dir).startsWith(`${bare(root)}/`)

/** A record kept by name belongs to the session that started in that folder within this long of it. */
export const PARKED_NAME_WINDOW_MS = 10 * 60_000

/**
 * A session's record: by its background id (`Session.key`). Else by the name it was started with
 * (`master spawn` could not read the id), but only for the session that started in that folder at
 * about that time: a session started by hand later under the same name is not the parked one.
 */
export function parkedFor(m: Record<string, Parked>, s: { key: string; name: string; cwd: string; startedAt: number }): Parked | null {
  if (m[s.key]) return m[s.key]
  const p = m[`name:${s.name}`]
  if (!p || p.at === undefined) return null
  return bare(s.cwd) === bare(p.dir) && Math.abs(s.startedAt - p.at) <= PARKED_NAME_WINDOW_MS ? p : null
}

/**
 * Is the branch of a session's folder the session's own: may it be given that branch's PR, and
 * may a ticket link record the branch? `branch`: its name, null for a detached HEAD, undefined
 * when it is not known (git failed or timed out).
 * - Never in a workspace (master's or an account's): every session shares it.
 * - No record (a session started by hand, or before this version): yes, as always. Working on a
 *   feature branch in a main checkout is a normal way to work.
 * - A PR review session MasterDeck started: never.
 * - Parked by MasterDeck: yes in a linked worktree. In a main checkout only in the one it was
 *   parked in (or a folder inside it), and only when the branch is known and is not the one it
 *   found there (it switched, or made its own). Any other main checkout (the prompt may send it
 *   on to another repository, left on someone's branch) and an unknown branch: no.
 */
export function ownsFolderBranch(o: { dir: string; workspaces: string[]; linked: boolean; branch: string | null | undefined; parked: Parked | null }): boolean {
  if (o.workspaces.some((w) => w && bare(w) === bare(o.dir))) return false
  if (!o.parked) return true
  if (o.parked.review) return false
  if (o.linked) return true
  return inside(o.dir, o.parked.dir) && o.branch !== undefined && (o.branch ?? '') !== o.parked.branch
}
