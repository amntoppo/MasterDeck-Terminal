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
  /** Not found, and the search stopped at a limit after this many folders: there may be one further on. */
  searched?: number
  /** Claude Code may work in `cwd` (see shared/trust.ts); null or missing: not known. */
  trusted?: boolean | null
}

export function folderOf(d: DraftAssign): StartFolder {
  return {
    cwd: d.cwd,
    ...(d.workspace ? { workspace: d.workspace } : {}),
    ...(typeof d.found === 'boolean' ? { found: d.found } : {}),
    ...(d.checkoutOf ? { checkoutOf: d.checkoutOf } : {}),
    ...(d.partial && typeof d.searched === 'number' ? { searched: d.searched } : {}),
    ...(d.trusted === true || d.trusted === false || d.trusted === null ? { trusted: d.trusted } : {}),
  }
}

/**
 * What to say about the folder: `found` (the repository's checkout), `missing` (no checkout in the
 * workspace: say so, the session still starts there; `missing-partial` when the search was cut
 * short), `chosen` / `chosen-found` (the user's own
 * pick), `plain` (nothing known: a proposal's folder, an older CLI).
 */
export type FolderKind = 'found' | 'missing' | 'missing-partial' | 'chosen' | 'chosen-found' | 'plain'

export function folderKind(f: StartFolder, chosen: boolean): FolderKind {
  if (chosen) return f.found && f.checkoutOf ? 'chosen-found' : 'chosen'
  if (!f.checkoutOf || typeof f.found !== 'boolean') return 'plain'
  return f.found ? 'found' : f.searched ? 'missing-partial' : 'missing'
}

const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/**
 * A draft made from master's proposal carries only the proposal's folder; `fresh` is the same ticket
 * looked up now. A checkout that exists now replaces the proposal's folder only when that folder is
 * a plain workspace (the one the resolver looked in, or the config's `top` one: the proposal is
 * older than the clone, or than per-account workspaces). Any other folder was chosen on purpose
 * (`master add --cwd`) and stays. Without a checkout the proposal's folder stays too, and is called
 * missing only when it is the workspace that was looked in.
 */
export function adoptFresh(proposalCwd: string, fresh: DraftAssign, top: string): StartFolder {
  const p = bare(proposalCwd)
  if (bare(fresh.cwd) === p) return folderOf(fresh)
  const isWorkspace = (!!fresh.workspace && bare(fresh.workspace) === p) || (!!top && bare(top) === p)
  return fresh.found && isWorkspace ? folderOf(fresh) : { cwd: proposalCwd }
}

/**
 * The system prompt after a new draft arrived (another folder): `next` replaces the current text
 * only while that is one MasterDeck wrote itself (`known`: the prompts of the drafts so far and
 * their `genericPrompt`). A prompt the user edited, or one master wrote by hand, stays.
 */
export function swapPrompt(current: string, known: string[], next: string): string {
  return known.includes(current) ? next : current
}

/**
 * What Start sends. Nothing differs from the draft: `edited` false, so master's own proposal is
 * approved as it is (no model or permission mode: either makes a new proposal). Anything differs: a new proposal,
 * which keeps the model master's proposal named unless one was picked in the dialog.
 */
export function startChoice(
  d: DraftAssign,
  now: { name: string; prompt: string; cwd: string; model: string; override: boolean; permissionMode?: string },
  proposalModel: string | undefined,
): { edited: boolean; model: string | undefined } {
  const unchanged = now.name === d.name && now.prompt === d.prompt.trim() && now.cwd === d.cwd && !now.model && !now.override && !now.permissionMode
  return unchanged ? { edited: false, model: undefined } : { edited: true, model: now.model || proposalModel || undefined }
}
