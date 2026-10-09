/**
 * The Sessions column's filters: status (its lane), account, repository or folder, starred and a
 * name search. Within one kind any picked value matches; the kinds combine (all must match).
 */
import { LANES, type Lane } from './tasks'

export interface SessionFilter {
  /** Lower-cased words to find in the name or ticket; empty: no search. Kept as typed. */
  q: string
  status: Lane[]
  /** Logins, or GH_ACTIVE for sessions started without an account. */
  accounts: string[]
  /** Folder roots (see `sessionFolder`). */
  folders: string[]
  starred: boolean
}

export const NO_FILTER: SessionFilter = { q: '', status: [], accounts: [], folders: [], starred: false }

/** The account value for a session started without one (it works as gh's active account). */
export const GH_ACTIVE = ':gh-active'

/** What a session must offer to be filtered. */
export interface Filterable {
  key: string
  name: string
  cwd: string
  account?: string
  ghActive?: boolean
  /** Its ticket as shown on the row ("#74", "acme/web#3"), if any. */
  ticket?: string | null
  /** The lane it is listed under (Parked for a suspended one). */
  lane: Lane
}

export interface FilterContext {
  stars: string[]
  /** Two or more accounts: only then does the account filter count. */
  multi: boolean
}

/**
 * The folder a session counts under: its repository's checkout for a session in one of its
 * worktrees (`<repo>/.claude/worktrees/<name>`), else its own folder.
 */
export function sessionFolder(cwd: string): string {
  const path = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const at = path.indexOf('/.claude/worktrees/')
  return at > 0 ? path.slice(0, at) : path || '/'
}

/** The last part of a folder, for its chip. */
export function folderLabel(folder: string): string {
  return folder.split('/').filter(Boolean).pop() ?? folder
}

/**
 * Chip text for each folder: its last part, or as many parts as it takes to tell it from the
 * others (`a/app`, `b/app`).
 */
export function folderLabels(folders: string[]): Map<string, string> {
  const parts = new Map(folders.map((d) => [d, d.split('/').filter(Boolean)]))
  const out = new Map<string, string>()
  for (const [d, p] of parts) {
    let n = 1
    const tail = (q: string[], k: number) => q.slice(-k).join('/')
    while (n < p.length && [...parts].some(([o, q]) => o !== d && tail(q, n) === tail(p, n))) n++
    out.set(d, tail(p, n) || d)
  }
  return out
}

const searchWords = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean)

function accountOf(s: Filterable): string | null {
  return s.ghActive ? GH_ACTIVE : (s.account ?? null)
}

export function matches(s: Filterable, f: SessionFilter, ctx: FilterContext): boolean {
  if (f.starred && !ctx.stars.includes(s.key)) return false
  if (f.status.length && !f.status.includes(s.lane)) return false
  if (ctx.multi && f.accounts.length) {
    const a = accountOf(s)
    if (!a || !f.accounts.includes(a)) return false
  }
  if (f.folders.length && !f.folders.includes(sessionFolder(s.cwd))) return false
  const words = searchWords(f.q)
  if (words.length) {
    // The name, the ticket and the repository's folder: "acme" or "tracker" finds its sessions too.
    const text = `${s.name} ${s.ticket ?? ''} ${folderLabel(sessionFolder(s.cwd))}`.toLowerCase()
    if (!words.every((w) => text.includes(w))) return false
  }
  return true
}

/** One filter that is on, as a chip: its text and the filter without it. */
export interface FilterChip {
  id: string
  label: string
  /** The whole value when the label is short for it (a folder's path). */
  title?: string
  without: SessionFilter
}

const laneTitle = (l: Lane) => LANES.find((x) => x.id === l)?.title ?? l

export function accountTitle(a: string): string {
  return a === GH_ACTIVE ? "gh's active account" : `@${a}`
}

/** The filters that are on (the count on the toggle and the chips under it); `labels` from `folderLabels`. */
export function activeChips(f: SessionFilter, multi: boolean, labels?: Map<string, string>): FilterChip[] {
  const out: FilterChip[] = []
  if (f.q.trim()) out.push({ id: 'q', label: `“${f.q.trim()}”`, without: { ...f, q: '' } })
  if (f.starred) out.push({ id: 'starred', label: '★ Starred', without: { ...f, starred: false } })
  for (const l of f.status)
    out.push({ id: `status:${l}`, label: laneTitle(l), without: { ...f, status: f.status.filter((x) => x !== l) } })
  if (multi)
    for (const a of f.accounts)
      out.push({ id: `account:${a}`, label: accountTitle(a), without: { ...f, accounts: f.accounts.filter((x) => x !== a) } })
  for (const d of f.folders)
    out.push({ id: `folder:${d}`, label: labels?.get(d) ?? folderLabel(d), title: d, without: { ...f, folders: f.folders.filter((x) => x !== d) } })
  return out
}

export function isFiltered(f: SessionFilter, multi: boolean): boolean {
  return activeChips(f, multi).length > 0
}

/** The sessions the filters let through, in the given order (the list itself when none is on). */
export function filterSessions<T extends Filterable>(list: T[], f: SessionFilter, ctx: FilterContext): T[] {
  return isFiltered(f, ctx.multi) ? list.filter((s) => matches(s, f, ctx)) : list
}

/** Filtering for Parked asks to see them: the fold is open, and its header does not close it. */
export function parkedForced(f: SessionFilter): boolean {
  return f.status.includes('parked')
}

/**
 * Shells and starting sessions have no status, account, repository or star: any of those filters
 * hides them, and the search looks at their label.
 */
export function shellsShown<T extends { label: string }>(tabs: T[], f: SessionFilter, multi: boolean): T[] {
  const kinds = f.starred || f.status.length > 0 || f.folders.length > 0 || (multi && f.accounts.length > 0)
  if (kinds) return []
  const words = searchWords(f.q)
  return words.length ? tabs.filter((t) => words.every((w) => t.label.toLowerCase().includes(w))) : tabs
}

/** Add a value to a list, or take it out. */
export function toggled<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

/** The folders to offer: those of the listed sessions, and any picked one (so it can be unpicked). */
export function folderChoices(sessions: Pick<Filterable, 'cwd'>[], picked: string[]): string[] {
  const all = new Set([...sessions.map((s) => sessionFolder(s.cwd)), ...picked])
  return [...all].sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)) || a.localeCompare(b))
}

/** The accounts to offer: every connected one, gh's active account when a session runs as it, any picked one. */
export function accountChoicesFor(logins: string[], sessions: Pick<Filterable, 'ghActive'>[], picked: string[]): string[] {
  const out = [...logins]
  if (sessions.some((s) => s.ghActive)) out.push(GH_ACTIVE)
  for (const p of picked) if (!out.includes(p)) out.push(p)
  return out
}

const LANE_IDS = new Set<string>(LANES.map((l) => l.id))
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []

/** A filter read back from storage: anything unknown or malformed dropped. */
export function cleanFilter(raw: unknown): SessionFilter {
  if (!raw || typeof raw !== 'object') return NO_FILTER
  const r = raw as Record<string, unknown>
  return {
    q: typeof r.q === 'string' ? r.q.slice(0, 200) : '',
    status: strings(r.status).filter((l) => LANE_IDS.has(l)) as Lane[],
    accounts: strings(r.accounts),
    folders: strings(r.folders),
    starred: r.starred === true,
  }
}
