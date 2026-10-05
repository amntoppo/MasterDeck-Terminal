import type { DraftAssign } from './types'

/**
 * The folder a ticket's session starts in, as the Start dialog shows it. The folder itself is picked
 * by the master CLI (`checkout.resolve`: the ticket's repository's checkout under its account's
 * workspace, else that workspace); this only reads its answer.
 */
export interface StartFolder {
  cwd: string
  /** The workspace that was looked in. */
  workspace?: string
  /** `cwd` is a checkout of `checkoutOf`. */
  found?: boolean
  /** owner/name of the ticket's repository. */
  checkoutOf?: string
}

export function folderOf(d: DraftAssign): StartFolder {
  return {
    cwd: d.cwd,
    ...(d.workspace ? { workspace: d.workspace } : {}),
    ...(typeof d.found === 'boolean' ? { found: d.found } : {}),
    ...(d.checkoutOf ? { checkoutOf: d.checkoutOf } : {}),
  }
}

/**
 * What to say about the folder: `found` (the repository's checkout), `missing` (no checkout in the
 * workspace: say so, the session still starts there), `chosen` / `chosen-found` (the user's own
 * pick), `plain` (nothing known: a proposal's folder, an older CLI).
 */
export type FolderKind = 'found' | 'missing' | 'chosen' | 'chosen-found' | 'plain'

export function folderKind(f: StartFolder, chosen: boolean): FolderKind {
  if (chosen) return f.found && f.checkoutOf ? 'chosen-found' : 'chosen'
  if (!f.checkoutOf || typeof f.found !== 'boolean') return 'plain'
  return f.found ? 'found' : 'missing'
}

/**
 * A draft made from master's proposal carries only the proposal's folder; `fresh` is the same ticket
 * looked up now. A checkout that exists now wins (the proposal may be older than the clone, or than
 * this lookup); without one the proposal's folder stays, and is called missing only when it is the
 * workspace that was looked in.
 */
export function adoptFresh(proposalCwd: string, fresh: DraftAssign): StartFolder {
  if (fresh.found || fresh.cwd === proposalCwd) return folderOf(fresh)
  return { cwd: proposalCwd }
}
