import { projectByKey, repoSelected, type AppConfig } from './appConfig'
import { parseCards } from './board'
import { boardDeriver, boardsOf, DERIVED_COLUMNS, repoBoardless, reposOf, type DeriveCtx } from './derivedBoard'
import { fullRepo, sameTicket, type Ticket } from './ticket'
import type { Board, BoardCard, RepoPart, RepoView } from './types'

/**
 * The Board's repository view: a tab whose Repos filter names repositories shows every issue of
 * those repositories (open, and closed lately), whether or not a project board holds it, in the
 * columns MasterDeck works out (shared/derivedBoard.ts). The issues are read only when a tab asks
 * (`master repo-issues`), kept per repository, and never touch `AppState.board`.
 */

/** Most repositories one ask may name. */
export const REPO_VIEW_MAX_ASK = 30
/** An ask reads a repository again when what MasterDeck has of it is older than this. */
export const REPO_VIEW_STALE_MS = 3_600_000
/** A repository counts as on screen (the hourly refresh and Refresh read it) this long after it was last asked for. */
export const REPO_VIEW_LIVE_MS = 3_600_000
/** A tab in repository view asks again this often, so its repositories stay "on screen". */
export const REPO_VIEW_ASK_MS = 20 * 60_000

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const short = (repo: string) => repo.split('/')[1] ?? repo
export const repoKey = (repo: string) => repo.toLowerCase()

/** Is this tab a repository view? Repositories are picked and its account has a board. (With no board the tab already shows its repositories' issues: picking one only filters.) */
export function repoViewOn(login: string | null | undefined, c: AppConfig, repos: string[]): boolean {
  return c.configured && repos.length > 0 && boardsOf(login, c).length > 0
}

/** The Repos filter's options: the account's ticked repositories, then any other seen on its cards, then picked ones that are neither (so they can be unpicked). Each once. */
export function repoChoices(login: string | null | undefined, c: AppConfig, seen: string[], picked: string[]): string[] {
  const out: string[] = []
  for (const r of [...reposOf(login, c), ...seen, ...picked]) if (r && !out.some((x) => repoKey(x) === repoKey(r))) out.push(r)
  return out
}

/** The repositories an ask may read: well-formed, selected in Setup, of an account with a board; each once, as Setup spells it. */
export function cleanRepos(v: unknown, c: AppConfig): string[] {
  if (!Array.isArray(v) || !c.configured) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string' || !REPO.test(x) || !repoSelected(x, c) || repoBoardless(x, c)) continue
    const name = c.repos.find((r) => repoKey(r) === repoKey(x)) ?? x
    if (!out.some((r) => repoKey(r) === repoKey(name))) out.push(name)
    if (out.length === REPO_VIEW_MAX_ASK) break
  }
  return out
}

/** What MasterDeck holds of one repository. */
export interface RepoEntry extends Omit<RepoPart, 'loading'> {
  cards: BoardCard[]
  /** When GitHub was last asked for it, answered or not (epoch ms). */
  triedAt: number
}
export type RepoEntries = Record<string, RepoEntry>

export interface RepoRead {
  parts: { repo: string; account: string | null; ok: boolean; total: number; shown: number; note?: string }[]
  cards: BoardCard[]
}

/** Parse `master repo-issues` output. Null for anything else. */
export function parseRepoIssues(raw: unknown): RepoRead | null {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!r || !Array.isArray(r.repos) || !Array.isArray(r.cards)) return null
  const count = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : 0)
  const parts: RepoRead['parts'] = []
  for (const p of r.repos) {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    if (typeof o.repo !== 'string' || !REPO.test(o.repo)) continue
    parts.push({ repo: o.repo, account: typeof o.account === 'string' ? o.account : null, ok: o.ok === true, total: count(o.total), shown: count(o.shown), ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}) })
  }
  return { parts, cards: parseCards(r.cards) }
}

/** The repositories among `repos` to read now: never read, or last asked for longer ago than REPO_VIEW_STALE_MS. */
export function needRead(entries: RepoEntries, repos: string[], now: number): string[] {
  return repos.filter((r) => {
    const e = entries[repoKey(r)]
    return !e || now - e.triedAt >= REPO_VIEW_STALE_MS
  })
}

/**
 * The entries after a read of `asked`. A repository the read gave: its part and cards replace what
 * was there. One it did not (its part says why, or the whole read failed with `error`): what was
 * there stays on screen, marked not ok with the reason.
 */
export function applyRead(entries: RepoEntries, asked: string[], read: RepoRead | null, error: string | null, now: number): RepoEntries {
  const out = { ...entries }
  for (const repo of asked) {
    const k = repoKey(repo)
    const prev = entries[k]
    const part = read?.parts.find((p) => repoKey(p.repo) === k)
    if (read && part?.ok) {
      out[k] = { repo, account: part.account, ok: true, total: part.total, shown: part.shown, ...(part.note ? { note: part.note } : {}), takenAt: now, triedAt: now, cards: read.cards.filter((c) => repoKey(fullRepo(c.repo)) === k) }
      continue
    }
    out[k] = {
      repo,
      account: part?.account ?? prev?.account ?? null,
      ok: false,
      total: prev?.total ?? 0,
      shown: prev?.shown ?? 0,
      note: part?.note ?? `${repo} not read: ${error ?? 'no answer for it'}`,
      takenAt: prev?.takenAt ?? null,
      triedAt: now,
      cards: prev?.cards ?? [],
    }
  }
  return out
}

/** The repositories still on screen somewhere: asked for within REPO_VIEW_LIVE_MS. */
export function liveRepos(asked: Record<string, { repo: string; at: number }>, now: number): string[] {
  return Object.values(asked)
    .filter((a) => now - a.at < REPO_VIEW_LIVE_MS)
    .map((a) => a.repo)
}

/** Without the repositories that are no longer selected in Setup, or whose account lost its board. The same object when nothing goes. */
export function pruneEntries(entries: RepoEntries, c: AppConfig): RepoEntries {
  const keep = Object.entries(entries).filter(([, e]) => repoSelected(e.repo, c) && !repoBoardless(e.repo, c))
  return keep.length === Object.keys(entries).length ? entries : Object.fromEntries(keep)
}

/** What goes into cache.json: the repositories that were read at least once. */
export function dumpEntries(entries: RepoEntries): Record<string, unknown> | undefined {
  const read = Object.entries(entries).filter(([, e]) => e.takenAt !== null)
  return read.length ? Object.fromEntries(read.map(([k, { triedAt: _tried, ...e }]) => [k, e])) : undefined
}

/** Back from cache.json; anything that is not an entry is left out. */
export function loadEntries(raw: unknown): RepoEntries {
  const out: RepoEntries = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const count = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : 0)
  for (const v of Object.values(raw as Record<string, unknown>)) {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    if (typeof o.repo !== 'string' || !REPO.test(o.repo) || typeof o.takenAt !== 'number') continue
    out[repoKey(o.repo)] = {
      repo: o.repo,
      account: typeof o.account === 'string' ? o.account : null,
      ok: o.ok === true,
      total: count(o.total),
      shown: count(o.shown),
      ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}),
      takenAt: o.takenAt,
      triedAt: o.takenAt,
      cards: parseCards(o.cards),
    }
  }
  return out
}

/** After an assign from a card: the card says so at once; the next read confirms it. The same object when no card matches. */
export function withAssignee(entries: RepoEntries, t: Ticket, login: string): RepoEntries {
  let hit = false
  const out = Object.fromEntries(
    Object.entries(entries).map(([k, e]) => {
      if (!e.cards.some((c) => sameTicket(c, t))) return [k, e]
      hit = true
      return [k, { ...e, cards: e.cards.map((c) => (sameTicket(c, t) ? { ...c, assignees: [login] } : c)) }]
    }),
  )
  return hit ? out : entries
}

/** The state's repository view, before the columns: undefined while nothing was ever asked for. `loading`: key → repository of the reads that run. */
export function viewOf(entries: RepoEntries, loading: ReadonlyMap<string, string>): RepoView | undefined {
  const keys = [...new Set([...Object.keys(entries), ...loading.keys()])]
  if (!keys.length) return undefined
  const repos: RepoPart[] = keys.map((k) => {
    const e = entries[k]
    const part: RepoPart = e
      ? { repo: e.repo, account: e.account, ok: e.ok, total: e.total, shown: e.shown, ...(e.note ? { note: e.note } : {}), takenAt: e.takenAt }
      : { repo: loading.get(k) ?? k, account: null, ok: false, total: 0, shown: 0, takenAt: null }
    return loading.has(k) ? { ...part, loading: true as const } : part
  })
  return { cards: Object.values(entries).flatMap((e) => e.cards), repos }
}

/**
 * Gives every card of the view its column (deriveBoard: closed ones older than 14 days go), and
 * hands back the view it made last time while the read is the same and no card changed column, so
 * a state build every few seconds does not make the Board lay out again.
 */
export function repoViewDeriver(): (v: RepoView | undefined, ctx: DeriveCtx) => RepoView | undefined {
  const derive = boardDeriver()
  let last: { from: RepoView; board: Board; cards: BoardCard[]; to: RepoView } | null = null
  return (v, ctx) => {
    if (!v) return undefined
    const board: Board = last?.from === v ? last.board : { takenAt: null, sprint: null, columns: [...DERIVED_COLUMNS], cards: v.cards }
    const cards = derive(board, ctx)?.cards ?? []
    if (last && last.from === v && last.cards === cards) return last.to
    last = { from: v, board, cards, to: { ...v, cards } }
    return last.to
  }
}

/** What a tab in repository view shows: the picked repositories' issues, in MasterDeck's four columns, on no board. */
export function repoViewBoard(v: RepoView | undefined, repos: string[]): Board {
  const want = new Set(repos.map(repoKey))
  return { takenAt: null, sprint: null, columns: [...DERIVED_COLUMNS], cards: (v?.cards ?? []).filter((c) => want.has(repoKey(fullRepo(c.repo)))), projects: [] }
}

export interface RepoStatus {
  /** A picked repository has nothing to show yet and its read runs (or was just asked for). */
  loading: boolean
  /** Picked repositories that were never read: there is nothing of them on screen. */
  failed: string[]
  /** What to say under the heading, one line each. */
  notes: string[]
}

/** Where the picked repositories stand: still loading, not read, and what the reads left out. */
export function repoViewStatus(v: RepoView | undefined, repos: string[], c: AppConfig): RepoStatus {
  const st: RepoStatus = { loading: false, failed: [], notes: [] }
  for (const r of repos) {
    if (!repoSelected(r, c)) {
      // A tab saved before the repository was unticked: it is never read.
      st.failed.push(r)
      st.notes.push(`${r} is not selected in Setup.`)
      continue
    }
    const p = v?.repos.find((x) => repoKey(x.repo) === repoKey(r))
    if (!p || (p.loading && p.takenAt === null)) {
      st.loading = true
      continue
    }
    if (p.takenAt === null) st.failed.push(r)
    if (p.shown < p.total) st.notes.push(`${short(r)}: showing the first ${p.shown} of ${p.total} open issues.`)
    if (p.note) st.notes.push(p.note)
  }
  return st
}

export type RepoEmpty = 'cards' | 'filtered' | 'loading' | 'not-read' | 'no-issues'

/** Why a tab in repository view shows no card: the filters hide them, the read still runs, a repository could not be read, or there is no issue. */
export function repoViewEmpty(o: { cards: number; shown: number }, st: RepoStatus): RepoEmpty {
  if (o.shown > 0) return 'cards'
  if (o.cards > 0) return 'filtered'
  if (st.loading) return 'loading'
  return st.failed.length ? 'not-read' : 'no-issues'
}

/** "Issues of api", "Issues of api, web", "Issues of api, web and 2 more repositories". */
export function repoViewTitle(repos: string[]): string {
  const names = repos.map(short)
  if (names.length <= 3) return `Issues of ${names.join(', ')}`
  return `Issues of ${names.slice(0, 2).join(', ')} and ${names.length - 2} more repositories`
}

/** The chips of a card in repository view: one per selected board that holds the issue, with its column there. */
export function boardChips(card: BoardCard, c: AppConfig): { key: string; text: string; title: string }[] {
  return (card.onBoards ?? []).map((b) => {
    const board = projectByKey(b.key, c)?.title ?? b.key
    return { key: b.key, text: b.status ?? 'No status', title: `On the ${board} board: ${b.status ?? 'no status'}` }
  })
}
