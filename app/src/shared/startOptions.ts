/**
 * The Start dialog's options beyond the draft: a worktree made for the ticket before the session
 * starts, the session's permission mode, and the choices remembered per repository.
 */

/** `claude --permission-mode` values the dialog offers. '' starts without the flag (Claude Code's default). */
export const PERMISSION_MODES: { value: string; label: string; hint: string }[] = [
  { value: '', label: 'Default', hint: "Claude Code's own default (settings.json)" },
  { value: 'plan', label: 'Plan mode', hint: 'It plans and asks before changing anything' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits go through without asking' },
  { value: 'auto', label: 'Auto', hint: 'Claude Code decides what needs asking' },
]

export const isPermissionMode = (v: unknown): v is string => typeof v === 'string' && PERMISSION_MODES.some((m) => m.value === v)

/** `<number>-<slug of the title>`: the branch a ticket's worktree gets unless another is typed. */
export function ticketBranch(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug ? `${number}-${slug}` : String(number)
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

/** Why git would refuse this as a ref name (the rules that matter for a typed name), or null. */
function refError(name: string, what: string): string | null {
  if (!name) return `${what} is empty.`
  if (!REF.test(name)) return `${what}: letters, digits, dot, dash, underscore and slash; it starts with a letter or digit (up to 100 characters).`
  if (name.includes('..') || name.includes('//') || /[./]$/.test(name) || /\.lock(\/|$)/.test(name) || /\/\./.test(name))
    return `${what}: git does not allow "..", "//", a part that starts with a dot, or an ending in "/", "." or ".lock".`
  return null
}

export const branchError = (name: string): string | null => refError(name, 'Branch name')
export const baseError = (name: string): string | null => refError(name, 'Base branch')

/** The worktree's folder name under `.claude/worktrees/`: the branch, with no folders inside it. */
export const worktreeDir = (branch: string): string => branch.replace(/\//g, '-')

/**
 * Said after the system prompt when MasterDeck made the worktree itself: the session is already in
 * it, so the "work in a git worktree" part of the prompt's first step is done.
 */
export function worktreeNote(w: { cwd: string; branch: string; base: string }): string {
  return (
    `MasterDeck already made the git worktree for this ticket: you are in it (${w.cwd}, branch ${w.branch}, ` +
    `made from ${w.base}). Work here. Do not create another worktree or branch; this replaces the worktree part of step 1.`
  )
}

/** What "Remember these choices" keeps, per repository. */
export interface StartPrefs {
  worktree: boolean
  /** '' = the repository's default branch, whatever it is then. */
  base: string
  model: string
  permissionMode: string
  workflow: string
  assignMe: boolean
}

export const NO_PREFS: StartPrefs = { worktree: false, base: '', model: '', permissionMode: '', workflow: 'default', assignMe: false }

/** The storage key of a repository's remembered choices (null: the primary issue repo). */
export const prefsKey = (repo: string | null | undefined): string => `startPrefs:${(repo ?? '').toLowerCase() || 'primary'}`

/** Stored choices as read back: anything that is not one of ours is dropped, never trusted. */
export function parsePrefs(raw: unknown): StartPrefs | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max = 100) => (typeof v === 'string' && v.length <= max ? v : '')
  const base = str(r.base)
  return {
    worktree: r.worktree === true,
    base: base && !baseError(base) ? base : '',
    model: /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/.test(str(r.model)) ? str(r.model) : '',
    permissionMode: isPermissionMode(r.permissionMode) ? r.permissionMode : '',
    workflow: str(r.workflow) || 'default',
    assignMe: r.assignMe === true,
  }
}
