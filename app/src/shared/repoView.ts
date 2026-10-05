import { accountForRepo } from './accounts'
import { primaryRepo, projectByKey, type AppConfig } from './appConfig'
import { parseCards } from './board'
import { boardDeriver, boardsOf, DERIVED_COLUMNS, repoBoardless, reposOf, type DeriveCtx } from './derivedBoard'
import { fullRepo, sameTicket, ticketKey, type Ticket } from './ticket'
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
/**
 * A repository counts as shown by a tab (never dropped to make room for another) this long after
 * it was last asked for: a little more than REPO_VIEW_ASK_MS, so a tab that is still there has
 * asked again. Shorter than REPO_VIEW_LIVE_MS on purpose: that one says how long a repository is
 * published and refreshed, this one how long it blocks a newcomer once MasterDeck is full.
 */
export const REPO_VIEW_HELD_MS = 25 * 60_000
/** Most repositories MasterDeck keeps entries for; past that, the one asked for longest ago that no tab shows goes. */
export const REPO_VIEW_MAX_ENTRIES = 30
/** A repository never read (its first read failed: offline, rate limit) is tried again after this, not after an hour. */
export const REPO_VIEW_RETRY_MS = 300_000
/** Most first reads that may wait or run at once: a browser cannot queue reads without limit. */
export const REPO_VIEW_MAX_QUEUED = 30
/** Most cards the state carries across every repository of the view. */
export const REPO_VIEW_MAX_CARDS = 1200
/**
 * Most bytes (UTF-8, as JSON) the view takes in the state, cards and parts together. The web bridge
 * drops a state whose JSON passes about 1.05 MB, which would lose the web's whole state: cards
 * differ a lot in size (five PRs, ten labels), so a count alone does not bound it.
 */
export const REPO_VIEW_MAX_BYTES = 500_000
/** A tab in repository view asks again this often, so its repositories stay "on screen". */
export const REPO_VIEW_ASK_MS = 20 * 60_000

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
/** owner/name as GitHub spells it: an owner never starts with a dash, and a name is never "." or "..". */
const validRepo = (s: string) => REPO.test(s) && !['.', '..'].includes(s.split('/')[1])
/** Is this owner/name as GitHub spells one? */
export const validRepoName = (s: unknown): s is string => typeof s === 'string' && validRepo(s)
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

/**
 * Does the config select this repository? Well-formed, and listed in Setup under any account; or,
 * not listed, its owner is the owner of an account that itself has "Select all" (no accounts: the
 * config's owner, with its "Select all"). One account's "Select all" never opens another account's
 * owner, and a login is no owner: an ask or a link can come from a paired browser, and must not
 * reach other people's repositories (the CLI's config.repo_readable).
 */
export function repoPickable(repo: string, c: AppConfig): boolean {
  if (!validRepo(repo)) return false
  if (c.repos.some((r) => repoKey(r) === repoKey(repo))) return true
  const owner = repo.split('/')[0].toLowerCase()
  if (c.accounts.length) return c.accounts.some((a) => a.allRepos === true && a.owner.toLowerCase() === owner)
  return c.allRepos && c.owner.toLowerCase() === owner
}

/** Is the Repos filter offered? With a board from one repository on (picking it is the repository view); with no board from two, as before. */
export function reposFilterOffered(options: number, noBoard: boolean): boolean {
  return options > (noBoard ? 1 : 0)
}

/**
 * May a session be linked to this issue though no selected board holds it (one the repository
 * view shows)? Only when its repository is known (none means the primary issue repo) and the
 * config selects it (`repoPickable`).
 */
export function offBoardOk(repo: string | null | undefined, c: AppConfig): boolean {
  const r = repo || primaryRepo(c)
  return !!r && c.configured && repoPickable(r, c)
}

/** The Repos filter's new pick: a tab with no board keeps "all picked" as none (its label and count as before); a tab with a board keeps the pick. */
export function reposFilterPick(picked: string[], options: number, noBoard: boolean): string[] {
  return noBoard && picked.length === options ? [] : picked
}

/** The board with each card of `moving` showing its new column at once; not in the repository view, where nothing moves. */
export function withMoving(board: Board | null, moving: Record<string, string>, repoMode: boolean): Board | null {
  if (!board || repoMode || !Object.keys(moving).length) return board
  return { ...board, cards: board.cards.map((c) => (moving[ticketKey(c.repo, c.number)] ? { ...c, status: moving[ticketKey(c.repo, c.number)] } : c)) }
}

/**
 * Why MasterDeck never reads this repository for a repository view, or null when it may: it is not
 * selected in Setup (`repoPickable`), or it is a repository of an account with no board (its issues
 * come with that account's own tab). The one rule for what an ask reads and what a tab says.
 */
export function repoRefusal(repo: string, c: AppConfig): string | null {
  if (!repoPickable(repo, c)) return `${repo} is not selected in Setup.`
  if (repoBoardless(repo, c)) {
    const login = c.accounts.length >= 2 ? accountForRepo(repo, c) : null
    return login ? `${repo} is a repository of ${login}, an account with no board: its issues are on that account's tab.` : `${repo} not read: there is no board, so the Board shows its issues already.`
  }
  return null
}

/** A list of repositories from a tab: the ones to read (each once, as Setup spells it), and the ones not read, each with why. */
export interface AskPlan {
  repos: string[]
  refused: { repo: string; reason: string }[]
}

/** The most names of one ask that are looked at: the list can come from a paired browser. */
const ASK_LOOKED_AT = 200

/**
 * What an ask may read (`repoRefusal`, and at most REPO_VIEW_MAX_ASK), and why the rest is not
 * read. Used by main for the ask and by the tab for what it says, so a picked repository that is
 * never read shows its reason instead of loading for ever.
 */
export function askPlan(v: unknown, c: AppConfig): AskPlan {
  const plan: AskPlan = { repos: [], refused: [] }
  if (!Array.isArray(v) || !c.configured) return plan
  const seen = new Set<string>()
  for (const x of v.slice(0, ASK_LOOKED_AT)) {
    if (typeof x !== 'string' || seen.has(repoKey(x))) continue
    seen.add(repoKey(x))
    const reason = repoRefusal(x, c) ?? (plan.repos.length >= REPO_VIEW_MAX_ASK ? `${x} not read: more than ${REPO_VIEW_MAX_ASK} repositories picked.` : null)
    if (reason) plan.refused.push({ repo: x, reason })
    else plan.repos.push(c.repos.find((r) => repoKey(r) === repoKey(x)) ?? x)
  }
  return plan
}

/** The repositories an ask may read (`askPlan`). */
export function cleanRepos(v: unknown, c: AppConfig): string[] {
  return askPlan(v, c).repos
}

export type Admit = { ok: true; evict?: string } | { ok: false; reason: string }

/**
 * May a repository MasterDeck holds nothing of be taken in? `held`: how many it holds; `idle`: the
 * keys of those no tab shows any more (not asked for within REPO_VIEW_HELD_MS, not being read), the
 * longest unasked first; `queued`: first reads that wait or run. One on screen is never pushed out
 * (two tabs with different repositories would otherwise read each other's away for ever), and
 * first reads cannot pile up: the newcomer is refused with a reason the tab shows.
 */
export function admitRepo(repo: string, o: { held: number; idle: string[]; queued: number }): Admit {
  if (o.queued >= REPO_VIEW_MAX_QUEUED) return { ok: false, reason: `${repo} not read: ${REPO_VIEW_MAX_QUEUED} repositories are already waiting for their first read. It is asked again in a few minutes.` }
  if (o.held < REPO_VIEW_MAX_ENTRIES) return { ok: true }
  if (o.idle.length) return { ok: true, evict: o.idle[0] }
  return { ok: false, reason: `${repo} not read: MasterDeck already shows ${REPO_VIEW_MAX_ENTRIES} repositories in open tabs. It makes room about 25 minutes after a tab stops showing one.` }
}

/**
 * The part of a failed repository's note that may start the pause of GitHub reads: what gh said
 * after "<repo> not read: ". Never the repository's name ("Not found: acme/rate-limiter" names no
 * rate limit), so null for every other note.
 */
export function pauseText(part: { repo: string; note?: string }): string | null {
  const lead = `${part.repo} not read: `
  return part.note?.startsWith(lead) ? part.note.slice(lead.length) : null
}

/** What MasterDeck holds of one repository. */
export interface RepoEntry extends Omit<RepoPart, 'loading' | 'cut'> {
  cards: BoardCard[]
  /** When GitHub was last asked for it, answered or not (epoch ms). */
  triedAt: number
}
export type RepoEntries = Record<string, RepoEntry>

export interface RepoRead {
  parts: { repo: string; account: string | null; ok: boolean; total: number; shown: number; note?: string }[]
  cards: BoardCard[]
}

/** The longest note kept of a part (the CLI cuts its own at this too): the parts are in every state push. */
const NOTE_MAX = 300

/** Parse `master repo-issues` output. Null for anything else. */
export function parseRepoIssues(raw: unknown): RepoRead | null {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!r || !Array.isArray(r.repos) || !Array.isArray(r.cards)) return null
  const count = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : 0)
  const parts: RepoRead['parts'] = []
  for (const p of r.repos) {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    if (typeof o.repo !== 'string' || !validRepo(o.repo)) continue
    parts.push({ repo: o.repo, account: typeof o.account === 'string' ? o.account : null, ok: o.ok === true, total: count(o.total), shown: count(o.shown), ...(typeof o.note === 'string' && o.note ? { note: o.note.slice(0, NOTE_MAX) } : {}) })
  }
  return { parts, cards: parseCards(r.cards) }
}

/** The repositories among `repos` to read now: never read, or last asked for longer ago than REPO_VIEW_STALE_MS. */
export function needRead(entries: RepoEntries, repos: string[], now: number): string[] {
  return repos.filter((r) => {
    const e = entries[repoKey(r)]
    if (!e || e.triedAt > now) return true // a trial from the future (a corrupt cache, a clock set back) counts as none
    return now - e.triedAt >= (e.takenAt === null ? REPO_VIEW_RETRY_MS : REPO_VIEW_STALE_MS)
  })
}

/** At most `max` entries: the ones asked for longest ago go first (never asked: first of all); `keep` never goes. The same object when nothing goes. */
export function trimEntries(entries: RepoEntries, asked: Record<string, { at: number }>, keep: ReadonlySet<string>, max = REPO_VIEW_MAX_ENTRIES): RepoEntries {
  const keys = Object.keys(entries)
  if (keys.length <= max) return entries
  const drop = new Set(
    keys
      .filter((k) => !keep.has(k))
      .sort((a, b) => (asked[a]?.at ?? -1) - (asked[b]?.at ?? -1))
      .slice(0, keys.length - max),
  )
  return Object.fromEntries(keys.filter((k) => !drop.has(k)).map((k) => [k, entries[k]]))
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
  const keep = Object.entries(entries).filter(([, e]) => repoRefusal(e.repo, c) === null)
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
    if (typeof o.repo !== 'string' || !validRepo(o.repo) || typeof o.takenAt !== 'number') continue
    out[repoKey(o.repo)] = {
      repo: o.repo,
      account: typeof o.account === 'string' ? o.account : null,
      ok: o.ok === true,
      total: count(o.total),
      shown: count(o.shown),
      ...(typeof o.note === 'string' && o.note ? { note: o.note.slice(0, NOTE_MAX) } : {}),
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

/** What each of `sizes` (key → how much it wants) gets when they do not all fit `max`: small ones whole, the rest an equal share. Only the cut ones are listed. */
function shares(sizes: (readonly [string, number])[], max: number): Map<string, number> {
  const sorted = [...sizes].sort((a, b) => a[1] - b[1])
  let left = Math.max(0, max)
  const cut = new Map<string, number>()
  sorted.forEach(([k, n], i) => {
    const share = Math.floor(left / (sorted.length - i))
    if (n > share) cut.set(k, share)
    left -= Math.min(n, share)
  })
  return cut
}

const utf8 = new TextEncoder()
const bytesOf = (v: unknown) => utf8.encode(JSON.stringify(v)).length
/** Per card on top of its JSON: the comma, and the column name the state writes over `status: null`. */
const CARD_SLACK = 16
/** Per part on top of its JSON: the comma, `loading` and `cut`, and the line that says it was cut. */
const PART_SLACK = 160

/**
 * How many cards each repository may show so that the view fits both budgets: `maxCards` cards and
 * `maxBytes` of JSON (`partsBytes` of it are the parts). Small repositories whole, the rest an
 * equal share, first of cards, then of bytes. Only the cut ones are listed.
 */
function fitCards(entries: RepoEntries, maxCards: number, maxBytes: number, partsBytes: number): Map<string, number> {
  const cut = shares(Object.entries(entries).map(([k, e]) => [k, e.cards.length] as const), maxCards)
  // Each repository's cards so far, as running byte totals: sums[n] is what its first n cards take.
  const sums = new Map<string, number[]>()
  for (const [k, e] of Object.entries(entries)) {
    const run = [0]
    for (const card of e.cards.slice(0, cut.get(k) ?? e.cards.length)) run.push(run[run.length - 1] + bytesOf(card) + CARD_SLACK)
    sums.set(k, run)
  }
  const byBytes = shares([...sums].map(([k, run]) => [k, run[run.length - 1]] as const), maxBytes - partsBytes - 64)
  for (const [k, share] of byBytes) {
    const run = sums.get(k)!
    let n = run.length - 1
    while (n > 0 && run[n] > share) n--
    cut.set(k, n)
  }
  return cut
}

/**
 * The state's repository view, before the columns: undefined while nothing was ever asked for.
 * `loading`: key → repository of the reads that run. `refused`: repositories asked for and not
 * taken in, each with why (a part that was never read). At most `maxCards` cards and `maxBytes`
 * of JSON: a repository that is cut says so in its note.
 */
export function viewOf(
  entries: RepoEntries,
  loading: ReadonlyMap<string, string>,
  o: { maxCards?: number; maxBytes?: number; refused?: ReadonlyMap<string, { repo: string; note: string }> } = {},
): RepoView | undefined {
  const refused = [...(o.refused ?? [])].filter(([k]) => !entries[k] && !loading.has(k))
  const keys = [...new Set([...Object.keys(entries), ...loading.keys()])]
  if (!keys.length && !refused.length) return undefined
  const parts = new Map<string, RepoPart>(
    keys.map((k) => {
      const e = entries[k]
      const part: RepoPart = e
        ? { repo: e.repo, account: e.account, ok: e.ok, total: e.total, shown: e.shown, ...(e.note ? { note: e.note } : {}), takenAt: e.takenAt }
        : { repo: loading.get(k) ?? k, account: null, ok: false, total: 0, shown: 0, takenAt: null }
      return [k, part]
    }),
  )
  for (const [k, r] of refused) parts.set(k, { repo: r.repo, account: null, ok: false, total: 0, shown: 0, note: r.note, takenAt: null })
  const partsBytes = [...parts.values()].reduce((n, p) => n + bytesOf(p) + PART_SLACK, 0)
  const share = fitCards(entries, o.maxCards ?? REPO_VIEW_MAX_CARDS, o.maxBytes ?? REPO_VIEW_MAX_BYTES, partsBytes)
  const repos: RepoPart[] = [...parts].map(([k, part]) => {
    const e = entries[k]
    const cut = share.get(k)
    const shown: RepoPart =
      cut !== undefined && e ? { ...part, note: [e.note, `${short(e.repo)}: showing the first ${cut} of the ${e.cards.length} issues read, to keep the view small.`].filter(Boolean).join(' '), cut: true } : part
    return loading.has(k) ? { ...shown, loading: true as const } : shown
  })
  return { cards: Object.entries(entries).flatMap(([k, e]) => (share.has(k) ? e.cards.slice(0, share.get(k)) : e.cards)), repos }
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
  /** One of `failed` could be read by a new ask (its read failed, or MasterDeck had no room for it): the tab asks sooner. */
  retry: boolean
  /** What to say under the heading, one line each. */
  notes: string[]
}

/**
 * Where the picked repositories stand: still loading, not read, and what the reads left out. A
 * repository main never reads (`askPlan`: unticked in Setup, another account's with no board,
 * past the most one tab may pick) is failed with its reason, never loading.
 */
export function repoViewStatus(v: RepoView | undefined, repos: string[], c: AppConfig): RepoStatus {
  const st: RepoStatus = { loading: false, failed: [], retry: false, notes: [] }
  const never = new Map(askPlan(repos, c).refused.map((r) => [repoKey(r.repo), r.reason]))
  const loading: string[] = []
  const seen = new Set<string>()
  for (const r of repos) {
    if (seen.has(repoKey(r))) continue
    seen.add(repoKey(r))
    const why = never.get(repoKey(r))
    if (why) {
      st.failed.push(r)
      st.notes.push(why)
      continue
    }
    const p = v?.repos.find((x) => repoKey(x.repo) === repoKey(r))
    if (!p || (p.loading && p.takenAt === null)) {
      st.loading = true
      loading.push(short(r))
      continue
    }
    if (p.takenAt === null) {
      st.failed.push(r)
      st.retry = true
    }
    // A cut part's own note says how many show: GitHub's count beside it would contradict it.
    if (!p.cut && p.shown < p.total) st.notes.push(`${short(r)}: showing the first ${p.shown} of ${p.total} open issues.`)
    if (p.note) st.notes.push(p.note)
  }
  if (loading.length) st.notes.push(`Loading ${loading.join(', ')}…`)
  return st
}

/** How often a tab in repository view asks: sooner while a picked repository was never read and a new ask could read it. */
export function repoAskEvery(st: RepoStatus): number {
  return st.retry ? REPO_VIEW_RETRY_MS : REPO_VIEW_ASK_MS
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
