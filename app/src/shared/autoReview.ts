/**
 * Automate Review and Merge automatically (#157), the pure half: the Pull requests view's Review
 * with Claude panel gets two switches per PR tab. main/autoReview.ts polls GitHub as the tab's
 * account for PRs whose review is asked of the user, sends each one to the tab's review session,
 * follows it (reviewing → comments sent → changes pushed → approved → ready → merged) and, when the
 * user agreed to it, merges what is ready. This file builds the query, reads the answer, decides
 * every step (`reconcile`), and holds the two rules that guard a merge: `readyToMerge`, `mergeGuard`.
 */
import { normalizePrFilters, type PrFilters } from './teamPrs'
import { safeRef, type PrRef } from './prWatch'

/** Where a track is. `stalled`: sent, but no review came within STALL_MS. */
export type AutoStatus = 'queued' | 'reviewing' | 'commented' | 'stalled' | 'approved' | 'ready' | 'merging' | 'merged' | 'closed' | 'merge-failed'

/** A PR tab's switches, and what main needs to act for it with nothing on screen. */
export interface AutoReviewTab {
  review: boolean
  merge: boolean
  /** The tab's name (the monitor's title, the context file). */
  name: string
  /** The tab's account (two or more accounts); null: the one account. */
  account: string | null
  filters: PrFilters
  /** When Automate Review was switched on. */
  since: number
}

/** One PR MasterDeck reviews for a tab. Keyed by account and URL (`trackKey`): one reviewer per PR. */
export interface AutoTrack {
  key: string
  url: string
  /** owner/name. */
  repo: string
  number: number
  title: string
  author: string
  tabId: string
  account: string | null
  status: AutoStatus
  /** The head commit last seen. */
  head: string
  /** The head commit the last review was asked for; null: not sent yet. */
  sentHead: string | null
  sentAt: number | null
  /** The review the account posted for it, and how many inline comments it had. */
  reviewUrl: string | null
  comments: number
  /** What was already told (`sent:<oid>`, `ready:<oid>`), so nothing is said twice. */
  told: string[]
  /** The head a merge was tried at (never tried twice for one head). */
  mergeTried: string | null
  /** Why not (merge failed, not ready, stalled). */
  note: string | null
  /** Its last change. */
  at: number
  /** Reads in a row that did not return it. */
  misses: number
}

/** A PR as the poll reads it. */
export interface AutoPr {
  url: string
  repo: string
  number: number
  title: string
  author: string
  draft: boolean
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  head: string
  base: string
  branch: string
  /** MERGEABLE, CONFLICTING, UNKNOWN. */
  mergeable: string
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  mergeState: string
  decision: string | null
  /** The head commit's checks rollup (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED), null: no checks. */
  checks: string | null
  additions: number
  deletions: number
  files: number
  /** The repository's default merge method for this account (MERGE, SQUASH, REBASE). */
  method: string | null
  /** Each reviewer's latest review. */
  reviews: { login: string; state: string; at: string; url: string; commit: string; comments: number }[]
}

export const POLL_MS = 2 * 60_000
/** A sent PR with no review from the account after this long is stalled (shown, not re-sent). */
export const STALL_MS = 60 * 60_000
/** Reads in a row without a tracked PR before it is dropped (gone, or no access). */
export const MISS_MAX = 3
/** Merged and closed tracks are kept this long (the widget's list, and no new review). */
export const DONE_KEEP_MS = 86_400_000
export const SEARCH_MAX = 30
/** Tracked PRs per GraphQL read. */
export const TRACK_MAX = 30
/** The user typed into the review pane this recently: MasterDeck does not type over them. */
export const TYPING_MS = 30_000

export const trackKey = (account: string | null, url: string): string => `${(account ?? '').toLowerCase()}\0${url}`

export const label = (t: { repo: string; number: number }): string => `${t.repo}#${t.number}`

const OWNER = /^[A-Za-z0-9-]{1,39}$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

/** The search for review requests to the user (or a team of theirs), scoped like the tab. */
export function autoSearch(owner: string | null, ownerType: 'organization' | 'user', repo: string): string {
  const base = `is:pr is:open review-requested:@me archived:false sort:updated-desc`
  if (!owner || !OWNER.test(owner)) return base
  if (repo && NAME.test(repo)) return `${base} repo:${owner}/${repo}`
  return `${base} ${ownerType === 'user' ? 'user' : 'org'}:${owner}`
}

const PR_FIELDS =
  'url number title isDraft state headRefOid baseRefName headRefName mergeable mergeStateStatus reviewDecision additions deletions changedFiles ' +
  'author{login} repository{nameWithOwner viewerDefaultMergeMethod} commits(last:1){nodes{commit{statusCheckRollup{state}}}} ' +
  'latestReviews(first:30){nodes{state submittedAt url author{login} commit{oid} comments{totalCount}}}'

/**
 * One read: who the account is, the search (when `search`), and each tracked PR by reference. A
 * read query: it never contains the word that makes the gh cache treat it as a write.
 */
export function autoQuery(tracked: PrRef[], search: boolean): string {
  if (!tracked.every(safeRef)) throw new Error('unsafe PR reference')
  const t = tracked.map((p, i) => `t${i}: repository(owner:"${p.owner}",name:"${p.repo}"){pullRequest(number:${p.number}){${PR_FIELDS}}}`).join(' ')
  return search
    ? `query($q: String!){viewer{login} s: search(query:$q, type: ISSUE, first: ${SEARCH_MAX}){nodes{... on PullRequest{${PR_FIELDS}}}} ${t}}`
    : `query{viewer{login} ${t}}`
}

type J = Record<string, unknown>
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const nodes = (v: unknown): J[] => (Array.isArray(o(v).nodes) ? (o(v).nodes as unknown[]).map(o) : [])

export function parseAutoPr(raw: unknown): AutoPr | null {
  const p = o(raw)
  const url = s(p.url)
  const repo = s(o(p.repository).nameWithOwner)
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url) || !repo || typeof p.number !== 'number') return null
  const st = s(p.state)
  const rollup = o(o(nodes(p.commits)[0]?.commit).statusCheckRollup)
  return {
    url,
    repo,
    number: p.number,
    title: s(p.title),
    author: s(o(p.author).login) || 'ghost',
    draft: p.isDraft === true,
    state: st === 'MERGED' ? 'MERGED' : st === 'CLOSED' ? 'CLOSED' : 'OPEN',
    head: s(p.headRefOid),
    base: s(p.baseRefName),
    branch: s(p.headRefName),
    mergeable: s(p.mergeable) || 'UNKNOWN',
    mergeState: s(p.mergeStateStatus) || 'UNKNOWN',
    decision: s(p.reviewDecision) || null,
    checks: s(rollup.state) || null,
    additions: n(p.additions),
    deletions: n(p.deletions),
    files: n(p.changedFiles),
    method: s(o(p.repository).viewerDefaultMergeMethod) || null,
    reviews: nodes(p.latestReviews)
      .map((r) => ({
        login: s(o(r.author).login),
        state: s(r.state),
        at: s(r.submittedAt),
        url: s(r.url),
        commit: s(o(r.commit).oid),
        comments: n(o(r.comments).totalCount),
      }))
      .filter((r) => r.login && r.state),
  }
}

/** The answer: the account's login, the search's PRs (null without a search), each tracked PR (null: not returned). */
export function parseAutoAnswer(text: string, tracked: number): { viewer: string | null; requested: AutoPr[] | null; tracked: (AutoPr | null)[] } {
  let data: J = {}
  try {
    data = o(o(JSON.parse(text)).data)
  } catch {
    // no JSON: nothing known
  }
  const viewer = s(o(data.viewer).login) || null
  const requested = 's' in data ? nodes(data.s).map(parseAutoPr).filter((p): p is AutoPr => !!p) : null
  return { viewer, requested, tracked: Array.from({ length: tracked }, (_, i) => parseAutoPr(o(data[`t${i}`]).pullRequest)) }
}

/** The account's own latest review of the PR, if any. */
export const myReview = (pr: AutoPr, viewer: string): AutoPr['reviews'][number] | null =>
  pr.reviews.find((r) => r.login.toLowerCase() === viewer.toLowerCase()) ?? null

/**
 * Why a PR is not ready to merge, or null when it is: open, not a draft, no conflicts, GitHub's
 * merge state CLEAN (required checks, approvals and branch protection all met), approved, every
 * check green (or none), and its head the commit MasterDeck's review was asked for.
 */
export function readyToMerge(pr: AutoPr, reviewedHead: string | null): string | null {
  if (pr.state !== 'OPEN') return `it is ${pr.state.toLowerCase()}`
  if (pr.draft) return 'it is a draft'
  if (pr.mergeable === 'CONFLICTING') return 'it has conflicts'
  if (pr.mergeable !== 'MERGEABLE') return 'GitHub has not worked out whether it can merge'
  if (pr.decision !== 'APPROVED') return pr.decision === 'CHANGES_REQUESTED' ? 'changes are requested' : 'it is not approved'
  if (pr.checks && pr.checks !== 'SUCCESS') return pr.checks === 'PENDING' || pr.checks === 'EXPECTED' ? 'checks are still running' : 'checks are failing'
  if (pr.mergeState !== 'CLEAN') return MERGE_STATE[pr.mergeState] ?? `GitHub says ${pr.mergeState.toLowerCase()}`
  if (!pr.head || pr.head !== reviewedHead) return 'its latest commits were not reviewed yet'
  return null
}

const MERGE_STATE: Record<string, string> = {
  BLOCKED: 'branch protection blocks it',
  BEHIND: 'its branch is behind the base',
  DIRTY: 'it has conflicts',
  UNSTABLE: 'a check is failing',
  HAS_HOOKS: 'it has merge hooks',
  DRAFT: 'it is a draft',
  UNKNOWN: 'GitHub has not worked out whether it can merge',
}

/**
 * Why MasterDeck must not merge this PR now, or null: Merge automatically is on for the tab that
 * tracks it, the PR is ready (readyToMerge), and no merge was tried at this head.
 */
export function mergeGuard(t: AutoTrack, pr: AutoPr, tab: AutoReviewTab | undefined, tabId: string): string | null {
  if (!tab || t.tabId !== tabId) return 'not this tab’s PR'
  if (!tab.review || !tab.merge) return 'Merge automatically is off'
  if (t.mergeTried === pr.head) return 'a merge was already tried at this commit'
  if (!pr.method || !['MERGE', 'SQUASH', 'REBASE'].includes(pr.method)) return 'the repository’s merge method is unknown'
  return readyToMerge(pr, t.sentHead)
}

/** The merge: as the account, the repository's default method, only if the head is still the checked one. Never --admin or --auto. */
export function mergeArgs(pr: AutoPr): string[] {
  return ['pr', 'merge', pr.url, `--${(pr.method ?? 'MERGE').toLowerCase()}`, '--match-head-commit', pr.head]
}

/** What reconcile wants said in Needs you. */
export interface AutoNotice {
  kind: 'sent' | 'ready'
  title: string
  body: string
  url: string
}

const checksText = (c: string | null): string =>
  !c ? 'none' : c === 'SUCCESS' ? 'passing' : c === 'PENDING' || c === 'EXPECTED' ? 'running' : 'failing'

const clean = (v: string, max: number): string =>
  v
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/** The one line MasterDeck types into the review session for a PR (never starts with / or !). */
export function autoPrompt(pr: AutoPr): string {
  const size = `+${pr.additions} −${pr.deletions} in ${pr.files} file${pr.files === 1 ? '' : 's'}`
  return clean(
    `[MasterDeck auto-review] Review ${label(pr)} "${clean(pr.title, 120)}" by ${clean(pr.author, 40)} ` +
      `(${clean(pr.base, 60)} ← ${clean(pr.branch, 60)}, ${size}, checks: ${checksText(pr.checks)}) ${pr.url} ` +
      `as "Automated reviews" in CLAUDE.md says, and post it with the post script's --auto form.`,
    1000,
  )
}

export interface ReconcileIn {
  tabId: string
  tab: AutoReviewTab
  viewer: string
  /** The search's PRs; null: the search was not read this time. */
  requested: AutoPr[] | null
  /** What the tracked reads returned, by URL (null: not returned). */
  tracked: Map<string, AutoPr | null>
  tracks: AutoTrack[]
  now: number
}

export interface ReconcileOut {
  tracks: AutoTrack[]
  notices: AutoNotice[]
  /** Tracks to merge now (each passed mergeGuard); the PR read with it. */
  merges: { track: AutoTrack; pr: AutoPr }[]
  /** The monitor's lines. */
  events: string[]
}

const DONE = new Set<AutoStatus>(['merged', 'closed'])

/**
 * One poll's answer for one tab, applied: new requests are queued (once per account and PR), each
 * of the tab's tracks moves on, and what to tell and to merge is returned. Pure.
 */
export function reconcile(x: ReconcileIn): ReconcileOut {
  const notices: AutoNotice[] = []
  const merges: ReconcileOut['merges'] = []
  const events: string[] = []
  const tracks = x.tracks.map((t) => ({ ...t, told: [...t.told] }))
  const byKey = new Map(tracks.map((t) => [t.key, t]))
  const seen = new Map<string, AutoPr>()
  for (const pr of x.requested ?? []) {
    seen.set(pr.url, pr)
    if (pr.state !== 'OPEN' || pr.draft || !pr.head) continue
    const key = trackKey(x.tab.account, pr.url)
    const have = byKey.get(key)
    // One reviewer per PR: another tab of the account has it, or it is being followed already.
    if (have && !DONE.has(have.status)) continue
    const t: AutoTrack = {
      key, url: pr.url, repo: pr.repo, number: pr.number, title: pr.title, author: pr.author, tabId: x.tabId, account: x.tab.account,
      status: 'queued', head: pr.head, sentHead: null, sentAt: null, reviewUrl: null, comments: 0, told: [], mergeTried: null, note: null, at: x.now, misses: 0,
    }
    if (have) tracks.splice(tracks.indexOf(have), 1, t)
    else tracks.push(t)
    byKey.set(key, t)
    events.push(`review requested: ${label(pr)} by ${pr.author}`)
  }
  for (const t of tracks) {
    if (t.tabId !== x.tabId || DONE.has(t.status)) continue
    const pr = seen.get(t.url) ?? x.tracked.get(t.url)
    if (pr === undefined) continue
    if (pr === null) {
      t.misses += 1
      continue
    }
    t.misses = 0
    advance(t, pr, x, notices, merges, events)
  }
  const keep = tracks.filter(
    (t) => t.misses < MISS_MAX && !(DONE.has(t.status) && x.now - t.at > DONE_KEEP_MS),
  )
  return { tracks: keep, notices, merges, events }
}

function move(t: AutoTrack, status: AutoStatus, now: number, note: string | null = null): void {
  if (t.status !== status) t.at = now
  t.status = status
  t.note = note
}

function advance(t: AutoTrack, pr: AutoPr, x: ReconcileIn, notices: AutoNotice[], merges: ReconcileOut['merges'], events: string[]): void {
  const name = label(t)
  t.title = pr.title
  t.head = pr.head
  if (pr.state === 'MERGED') {
    if (t.status !== 'merging') events.push(`${name} was merged`)
    return move(t, 'merged', x.now)
  }
  if (pr.state === 'CLOSED') {
    events.push(`${name} was closed`)
    return move(t, 'closed', x.now)
  }
  if (t.status === 'queued' || t.status === 'merging') return
  const mine = myReview(pr, x.viewer)
  if (t.status === 'reviewing' || t.status === 'stalled') {
    // The account's review of the sent commit (or posted after it was sent).
    // Posted after it was asked for (a minute of clock skew): an older review by the account is not it.
    const posted = mine && t.sentAt !== null && Date.parse(mine.at) >= t.sentAt - 60_000
    if (!posted) {
      // Stalled, then new commits: asked again.
      if (t.status === 'stalled' && t.sentHead && pr.head !== t.sentHead) {
        events.push(`changes pushed to ${name}: reviewing again`)
        return move(t, 'queued', x.now, 'changes pushed')
      }
      if (t.status === 'reviewing' && t.sentAt !== null && x.now - t.sentAt > STALL_MS) {
        move(t, 'stalled', x.now, 'no review was posted within an hour')
        events.push(`${name}: no review posted within an hour`)
      }
      return
    }
    t.reviewUrl = mine.url || null
    t.comments = mine.comments
    move(t, 'commented', x.now)
    const told = `sent:${t.sentHead}`
    if (!t.told.includes(told)) {
      t.told.push(told)
      events.push(`review sent on ${name} (${mine.comments} comment${mine.comments === 1 ? '' : 's'})`)
      notices.push({
        kind: 'sent',
        title: `Review comments sent on ${name}`,
        body: `${mine.comments} inline comment${mine.comments === 1 ? '' : 's'} · ${clean(pr.title, 120)}`,
        url: t.reviewUrl ?? t.url,
      })
    }
  }
  // New commits after the review: it is reviewed again.
  if (t.sentHead && pr.head !== t.sentHead) {
    events.push(`changes pushed to ${name}: reviewing again`)
    return move(t, 'queued', x.now, 'changes pushed')
  }
  const why = readyToMerge(pr, t.sentHead)
  if (why) {
    if (t.status === 'merge-failed') return
    return move(t, pr.decision === 'APPROVED' ? 'approved' : 'commented', x.now, why)
  }
  if (t.status !== 'merge-failed') move(t, 'ready', x.now)
  const told = `ready:${pr.head}`
  if (!t.told.includes(told)) {
    t.told.push(told)
    events.push(`${name} is ready to merge`)
    notices.push({ kind: 'ready', title: `${name} is ready to merge`, body: `Approved, checks green, no conflicts · ${clean(pr.title, 120)}`, url: t.url })
  }
  if (!mergeGuard(t, pr, x.tab, x.tabId)) {
    move(t, 'merging', x.now)
    t.mergeTried = pr.head
    merges.push({ track: t, pr })
  }
}

/** The review pane's turn, from the file its hooks write: "start" (just started), "idle" (stopped), "busy". */
export function parseTurn(text: string | null): 'start' | 'idle' | 'busy' | null {
  const v = (text ?? '').trim()
  return v === 'start' || v === 'idle' || v === 'busy' ? v : null
}

/** A tab's switches from a caller: anything not understood is off. */
export function normalizeTab(v: unknown, prev?: AutoReviewTab, now = Date.now()): AutoReviewTab {
  const x = o(v)
  const review = x.review === true
  return {
    review,
    merge: review && x.merge === true,
    name: s(x.name).slice(0, 100) || prev?.name || 'PRs',
    account: typeof x.account === 'string' && x.account ? x.account : null,
    filters: normalizePrFilters(x.filters ?? prev?.filters),
    since: review ? (prev?.review ? prev.since : now) : 0,
  }
}

/** What the window shows per tab (AppState.autoReview). */
export interface AutoReviewTabView {
  review: boolean
  merge: boolean
  lastCheck: number | null
  error: string | null
  /** The review pane MasterDeck started or typed into, if it runs. */
  pane: string | null
}

export interface AutoReviewView {
  tabs: Record<string, AutoReviewTabView>
  prs: Pick<AutoTrack, 'url' | 'repo' | 'number' | 'title' | 'author' | 'tabId' | 'status' | 'at' | 'reviewUrl' | 'comments' | 'note'>[]
}

const ago = (ms: number): string => {
  const m = Math.round(Math.max(0, ms) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

/** The widget's line: "Watching · 2 reviews in progress · last check 1 min ago". */
export function autoStatusLine(tab: AutoReviewTabView | undefined, prs: AutoReviewView['prs'], tabId: string, now: number): string {
  if (!tab?.review) return 'Off'
  const mine = prs.filter((p) => p.tabId === tabId)
  const busy = mine.filter((p) => p.status === 'queued' || p.status === 'reviewing').length
  const ready = mine.filter((p) => p.status === 'ready').length
  return [
    tab.error ? `Can't check: ${tab.error}` : 'Watching',
    busy ? `${busy} review${busy === 1 ? '' : 's'} in progress` : null,
    ready ? `${ready} ready to merge` : null,
    tab.lastCheck !== null ? `last check ${ago(now - tab.lastCheck)}` : 'checking…',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Status words for the widget's list. */
export const STATUS_TEXT: Record<AutoStatus, string> = {
  queued: 'waiting to be reviewed',
  reviewing: 'reviewing',
  commented: 'comments sent',
  stalled: 'no review yet',
  approved: 'approved',
  ready: 'ready to merge',
  merging: 'merging',
  merged: 'merged',
  closed: 'closed',
  'merge-failed': 'could not merge',
}

const BORDER = /^\s*[╭╰]?[─━]{8,}[╮╯]?\s*$/
const PROMPT = /^\s*(│\s*)?[>❯›](\s|$)/

/**
 * Claude Code's input box on a terminal screen (its rows, top border to bottom border), for the
 * widget that lines up with it; null when none is on screen. Both of its looks: a rounded box
 * (`╭─╮ │ > │ ╰─╯`), and rules above and below the `>` line. The lowest one wins.
 */
export function inputBoxRows(lines: string[]): { top: number; bottom: number } | null {
  for (let b = lines.length - 1; b >= 1; b--) {
    if (!BORDER.test(lines[b])) continue
    for (let t = b - 1; t >= Math.max(0, b - 12); t--) {
      if (!BORDER.test(lines[t])) continue
      if (lines.slice(t + 1, b).some((l) => PROMPT.test(l))) return { top: t, bottom: b }
      break
    }
  }
  return null
}
