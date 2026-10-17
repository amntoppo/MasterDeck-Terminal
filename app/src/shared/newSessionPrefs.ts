/**
 * The New Claude session dialog's memory (#153): per account, the folder, model, workflow and
 * permission mode of the last start, and which account that was. Name, first message and linked
 * sessions belong to one session and are never kept. Stored in localStorage by the renderer.
 * ponytail: per browser (the Mac's window and each web tab's browser keep their own); a store on the
 * Mac behind a `prefs:*` channel is the upgrade if one memory everywhere is wanted.
 */

/** One account's last choices. '' model / mode = the default option. */
export interface NewSessionChoice {
  cwd: string
  model: string
  workflow: string
  mode: string
}

export interface NewSessionPrefs {
  /** The account of the last start (null: one account, or never started). */
  last: string | null
  /** Keyed by login; '' holds the one set kept with a single account. */
  by: Record<string, NewSessionChoice>
}

export const NEW_SESSION_PREFS_KEY = 'newSessionPrefs'
export const NO_NEW_SESSION_PREFS: NewSessionPrefs = { last: null, by: {} }
const MAX_ACCOUNTS = 20

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : '')

/** Stored prefs as read back: anything that is not one of ours is dropped, never trusted. */
export function parseNewSessionPrefs(raw: unknown): NewSessionPrefs {
  if (!raw || typeof raw !== 'object') return NO_NEW_SESSION_PREFS
  const r = raw as Record<string, unknown>
  const by: Record<string, NewSessionChoice> = {}
  const src = r.by && typeof r.by === 'object' ? (r.by as Record<string, unknown>) : {}
  for (const [k, v] of Object.entries(src).slice(-MAX_ACCOUNTS)) {
    if ((k !== '' && !LOGIN.test(k)) || !v || typeof v !== 'object') continue
    const c = v as Record<string, unknown>
    by[k] = { cwd: str(c.cwd, 4096), model: str(c.model, 80), workflow: str(c.workflow, 200), mode: str(c.mode, 40) }
  }
  const last = typeof r.last === 'string' && LOGIN.test(r.last) ? r.last : null
  return { last, by }
}

/** The key an account's choices live under: its login with two or more accounts, '' with one. */
export const prefsAccountKey = (multi: boolean, login: string | null | undefined): string | null => (multi ? login || null : '')

/** That account's last choices, if any. */
export function choiceFor(p: NewSessionPrefs, multi: boolean, login: string | null | undefined): NewSessionChoice | null {
  const k = prefsAccountKey(multi, login)
  return k === null ? null : (p.by[k] ?? null)
}

/** The prefs after a start with `choice` as `login`: that account's set replaced, `last` set, the others kept. */
export function rememberChoice(p: NewSessionPrefs, multi: boolean, login: string | null | undefined, choice: NewSessionChoice): NewSessionPrefs {
  const k = prefsAccountKey(multi, login)
  if (k === null) return p
  const by: Record<string, NewSessionChoice> = {}
  // Newest last; the oldest goes when there are too many.
  for (const key of Object.keys(p.by).filter((x) => x !== k).slice(-(MAX_ACCOUNTS - 1))) by[key] = p.by[key]
  by[k] = { ...choice }
  return { last: multi ? k : p.last, by }
}

/** The account the dialog opens on: the last one started, while it is still a connected, healthy account; else null (today's rule: the folder's). */
export function initialAccount(p: NewSessionPrefs, multi: boolean, choices: string[]): string | null {
  return multi && p.last && choices.includes(p.last) ? p.last : null
}

/** What the dialog can offer, to check a remembered choice against. */
export interface ChoiceContext {
  /** The folder the dialog would open on without memory (the workspace). */
  defaultCwd: string
  /** Whether the remembered folder still exists (checked by the caller: it takes a read). */
  cwdExists: boolean
  models: string[]
  /** The model settings.json names: the list shows it as the Default option. */
  configured: string | null
  /** Template ids; empty when the list could not be read (no check, no note). */
  workflows: string[]
  defaultWorkflow: string
  modes: string[]
}

export type ChoiceNotes = Partial<Record<keyof NewSessionChoice, string>>

/** A remembered choice made safe to show: each value that is gone falls back to its default with a note (per field, so the dialog can drop one the user has since changed). */
export function resolveChoice(c: NewSessionChoice | null, x: ChoiceContext): { choice: NewSessionChoice; notes: ChoiceNotes } {
  const out: NewSessionChoice = { cwd: x.defaultCwd, model: '', workflow: x.defaultWorkflow, mode: '' }
  const notes: ChoiceNotes = {}
  if (!c) return { choice: out, notes }
  if (c.cwd) {
    if (x.cwdExists) out.cwd = c.cwd
    else notes.cwd = `The last folder, ${c.cwd}, is gone: using the workspace.`
  }
  if (c.model) {
    if (c.model === x.configured) out.model = ''
    else if (x.models.includes(c.model)) out.model = c.model
    else notes.model = `The last model, ${c.model}, is no longer offered: using the default.`
  }
  if (c.workflow && x.workflows.length) {
    if (x.workflows.includes(c.workflow)) out.workflow = c.workflow
    else notes.workflow = 'The last workflow was removed: using the default.'
  }
  if (c.mode) {
    if (x.modes.includes(c.mode)) out.mode = c.mode
    else notes.mode = 'The last permission mode is no longer offered: using your settings.'
  }
  return { choice: out, notes }
}
