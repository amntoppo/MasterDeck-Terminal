import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/**
 * The repositories MasterDeck works with on disk: one listing for the Janitor, Remove worktree,
 * the + menu, standup and the Workflow view. Which checkout a ticket's session starts in is the
 * master CLI's business (`checkout.py`); this follows its depth rule so every folder a session
 * can be started in is also one MasterDeck looks after.
 */

/** `~` and `~/x` as the CLI reads them (`os.path.expanduser`). */
export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

type Kind = 'checkout' | 'worktree' | 'plain'

function kindOf(d: string): Kind {
  try {
    const st = statSync(join(d, '.git'))
    return st.isDirectory() ? 'checkout' : 'worktree'
  } catch {
    return 'plain'
  }
}

/** Sub-folders by name: no hidden ones, no links leading out of `root`. */
function folders(parent: string, root: string): string[] {
  let names: string[]
  try {
    names = readdirSync(parent).filter((n) => !n.startsWith('.')).sort()
  } catch {
    return []
  }
  return names
    .map((n) => join(parent, n))
    .filter((d) => {
      try {
        const real = realpathSync(d)
        return statSync(d).isDirectory() && real !== root && real.startsWith(root + sep)
      } catch {
        return false
      }
    })
}

/**
 * The checkouts (a `.git` folder) in a workspace, by the resolver's rule: the workspace itself, its
 * sub-folders, and the sub-folders of those that are plain folders. Linked worktrees are neither
 * listed nor looked into. At most `max` folders are looked at.
 */
export function listCheckouts(ws: string, max = 2000): string[] {
  let root: string
  try {
    root = realpathSync(ws)
  } catch {
    return []
  }
  const out: string[] = []
  let seen = 0
  const look = (d: string): Kind | null => {
    if (seen >= max) return null
    seen++
    const k = kindOf(d)
    if (k === 'checkout') out.push(d)
    return k
  }
  look(ws)
  const plain: string[] = []
  for (const d of folders(ws, root)) {
    const k = look(d)
    if (k === null) return out
    if (k === 'plain') plain.push(d)
  }
  for (const d of plain) for (const e of folders(d, root)) if (look(e) === null) return out
  return out
}

/** What `Ops.repos()` always listed for the workspace from Setup: its sub-folders with a `.git`, or its siblings when it is a repo itself. */
function direct(ws: string): string[] {
  const root = existsSync(join(ws, '.git')) ? dirname(ws) : ws
  try {
    return readdirSync(root)
      .map((d) => join(root, d))
      .filter((d) => existsSync(join(d, '.git')))
  } catch {
    return []
  }
}

/**
 * Every repository folder: the primary workspace's as before (first, unchanged), then its
 * checkouts one level further down, then every other account's workspace by the same rule. Each
 * folder once. One account with its repos directly in the workspace: exactly the old list.
 */
export function workspaceRepos(primary: string, others: string[]): string[] {
  const out: string[] = []
  const add = (ds: string[]) => {
    for (const d of ds) if (!out.includes(d)) out.push(d)
  }
  const first = expandHome(primary)
  add(direct(first))
  add(listCheckouts(first))
  for (const o of others) if (o && o.trim()) add(listCheckouts(expandHome(o.trim())))
  return out
}
