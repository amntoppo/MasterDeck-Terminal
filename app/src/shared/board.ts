import type { PastSession } from './pastSessions'
import { getConfig, projectKey, statusRank, type StatusMap } from './appConfig'
import { sessionForIssue } from './derive'
import { STATUS_TEXT, type PrStage, type StatusKey } from './review'
import { sameTicket, storedRepo, type Ticket } from './ticket'
import { proposalTicket } from './derive'
import type { Badge, Board, BoardCard, BoardPr, Proposal, Session } from './types'

/** Columns shown even when empty: the workflow from "ready" to "dev done", in board order. */
export function alwaysColumns(c = getConfig()): string[] {
  return alwaysFor(c.statuses, c.columns, (x) => statusRank(x, c))
}

function alwaysFor(s: StatusMap, columns: string[], rank: (x: string) => number): string[] {
  const want = new Set([...s.assignable.filter((x) => rank(x) <= rank(s.ready)), s.ready, s.inProgress, s.prRaised, s.devDone])
  const inBoard = columns.filter((x) => want.has(x))
  return inBoard.length ? inBoard : [...want]
}

/** The always-shown columns of some boards (all selected boards when `projects` is empty). */
export function alwaysColumnsOf(projects: string[] = [], c = getConfig()): string[] {
  const boards = c.projects.filter((p) => !projects.length || projects.includes(projectKey(p)))
  if (!boards.length) return alwaysColumns(c)
  return [...new Set(boards.flatMap((p) => alwaysFor(p.statuses, p.columns, (x) => statusRank(x, c, projectKey(p)))))]
}
export const NO_STATUS = 'No status'

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

const CI = new Set(['success', 'failure', 'pending'])

/** The cards of `master board` or `master repo-issues` output; anything that is not a card is left out. */
export function parseCards(raw: unknown): BoardCard[] {
  const cards: BoardCard[] = []
  for (const c of arr(raw).map(obj)) {
    if (typeof c.number !== 'number') continue
    const prs: BoardPr[] = []
    for (const p of arr(c.prs).map(obj)) {
      const url = str(p.url)
      if (!url || typeof p.number !== 'number') continue
      prs.push({
        url,
        owner: str(p.owner) ?? undefined,
        repo: str(p.repo) ?? '',
        number: p.number,
        state: str(p.state),
        ci: CI.has(p.ci as string) ? (p.ci as BoardPr['ci']) : null,
        unresolved: typeof p.unresolved === 'number' ? p.unresolved : 0,
      })
    }
    const strs = (v: unknown) => arr(v).filter((x): x is string => typeof x === 'string')
    cards.push({
      number: c.number,
      repo: storedRepo(str(c.repo)),
      project: str(c.project),
      title: str(c.title) ?? `#${c.number}`,
      url: str(c.url) ?? '',
      status: str(c.status),
      prs,
      assignees: strs(c.assignees),
      labels: strs(c.labels),
      milestone: str(c.milestone),
      type: str(c.type),
      // An issue of an account with no board: facts only (its column comes from deriveBoard).
      ...(c.derived === true ? { derived: true as const, state: c.state === 'CLOSED' ? ('CLOSED' as const) : ('OPEN' as const), closedAt: str(c.closedAt) } : {}),
      // Repository view: the boards that hold the issue (never on a card of `master board`).
      ...(c.derived === true && onBoards(c.onBoards).length ? { onBoards: onBoards(c.onBoards) } : {}),
    })
  }
  return cards
}

function onBoards(v: unknown): { key: string; status: string | null }[] {
  return arr(v)
    .map(obj)
    .filter((x) => typeof x.key === 'string' && x.key.length > 0)
    .map((x) => ({ key: x.key as string, status: str(x.status) }))
}

/** Parse `master board` output. Null for anything that isn't a board. */
export function parseBoard(raw: unknown): Board | null {
  const r = obj(raw)
  if (!Array.isArray(r.cards)) return null
  const cards = parseCards(r.cards)
  const columns = arr(r.columns).filter((x): x is string => typeof x === 'string')
  const projects = arr(r.projects)
    .map(obj)
    .filter((p) => typeof p.key === 'string')
    .map((p) => ({ key: p.key as string, title: str(p.title) ?? (p.key as string), columns: arr(p.columns).filter((x): x is string => typeof x === 'string') }))
  const list = (v: unknown) => arr(v).filter((x): x is string => typeof x === 'string')
  const count = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : 0)
  const parts = arr(r.derived)
    .map(obj)
    .filter((d) => Array.isArray(d.repos))
  // What a read could not do: on its account's part. A master CLI that only prints them at the
  // top: they are the one part's when there is one (with several they cannot be told apart).
  const notesOf = (d: Record<string, unknown>) => (list(d.notes).length ? list(d.notes) : parts.length === 1 ? list(r.notes) : [])
  const derived = parts.map((d) => ({ account: str(d.account), repos: list(d.repos), total: count(d.total), shown: count(d.shown), skipped: list(d.skipped), missing: list(d.missing), ...(notesOf(d).length ? { notes: notesOf(d) } : {}) }))
  return { takenAt: str(r.taken_at), sprint: str(r.sprint), columns: columns.length ? columns : alwaysColumns(), cards, projects, ...(derived.length ? { derived } : {}) }
}

/** Always the five workflow columns (of the boards shown: `projects`, empty for all); any other
 * only when it has a card; "No status" first when needed. */
export function visibleColumns(b: Board, projects: string[] = []): string[] {
  const used = new Set(b.cards.map((c) => c.status))
  const always = alwaysColumnsOf(projects)
  const cols = b.columns.filter((c) => always.includes(c) || used.has(c))
  for (const c of always) if (!cols.includes(c)) cols.push(c)
  for (const s of used) if (s && !cols.includes(s)) cols.push(s)
  return used.has(null) ? [NO_STATUS, ...cols] : cols
}

export function cardsIn(b: Board, column: string): BoardCard[] {
  return b.cards.filter((c) => (column === NO_STATUS ? c.status === null : c.status === column))
}

const LABEL: Record<Badge['kind'], string> = {
  question: 'Question',
  blocked: 'Blocked',
  'needs-input': 'Needs input',
  onboarding: 'Onboarding',
  working: 'Working',
  merged: STATUS_TEXT.merged,
  rework: STATUS_TEXT.rework,
  approved: STATUS_TEXT.approved,
  changes: STATUS_TEXT.changes,
  'ci-failing': STATUS_TEXT['ci-failing'],
  ready: STATUS_TEXT.ready,
  'in-review': STATUS_TEXT['in-review'],
  waiting: STATUS_TEXT.waiting,
  done: 'Done',
  idle: 'Idle',
  stopped: 'Stopped',
  none: 'No session',
}

function badge(kind: Badge['kind'], detail?: string | null): Badge {
  return detail ? { kind, label: LABEL[kind], detail } : { kind, label: LABEL[kind] }
}

/**
 * The Claude task state of an issue, first match wins: question, blocked, needs input, onboarding,
 * working, where its session's PR stands (merged, approved, changes requested, CI failing, ready for
 * review, in review: `stages`, see shared/review.ts), done, idle, stopped (a session worked on it and
 * can be resumed), no session.
 */
export function cardBadge(issue: Ticket, sessions: Session[], proposals: Proposal[], past: PastSession[] = [], stages: Record<string, PrStage> = {}, manual: Record<string, StatusKey> = {}): Badge {
  const mine = proposals.filter((p) => sameTicket(proposalTicket(p), issue) && p.kind !== 'CHAT').sort((a, b) => b.id - a.id)
  const q = mine.find((p) => p.status === 'question')
  if (q) return badge('question', q.note)
  const bl = mine.find((p) => p.status === 'blocked')
  if (bl) return badge('blocked', bl.note)
  const s = sessionForIssue(sessions, issue)
  // Set by hand in the session's status popup (a prompt waiting still shows as needs input).
  const hand = s ? manual[s.key] : undefined
  if (hand && s?.state !== 'needs-input' && hand in LABEL) return badge(hand as Badge['kind'], 'set by you')
  if (s?.state === 'needs-input') return badge('needs-input')
  const assign = mine.find((p) => p.kind === 'ASSIGN' && p.status !== 'rejected')
  // Spawning, or spawned but not yet linked to the issue (babysit-ticket does that while setting up).
  if (assign && (assign.status === 'approved' || (assign.status === 'sent' && !s))) return badge('onboarding')
  if (s?.state === 'working' && !s.waitingOn && !s.busyWith) return badge('working')
  if (s?.busyWith && !s.asking) return badge('working', s.busyWith)
  if (s?.asking) return badge('question', s.asking.replace(/\s+/g, ' ').slice(-200))
  const stage = s ? stages[s.key] : undefined
  if (stage) return badge(stage.kind, `PR ${stage.prs.map((n) => `#${n}`).join(', ')}: ${stage.why}`)
  if (assign?.status === 'done') return badge('done', assign.note)
  if (s?.waitingOn) return badge('waiting', s.waitingOn)
  if (s) return badge('idle')
  if (past.length) return badge('stopped', `${past[0].name}: stopped, can be resumed`)
  return badge('none')
}

/**
 * Columns in the user's saved order. Columns the order names are placed, in that order, into the
 * slots they already fill; columns it doesn't name (new ones) keep their place.
 */
export function orderColumns(cols: string[], order: string[]): string[] {
  const rank = new Map(order.map((c, i) => [c, i]))
  const known = cols.filter((c) => rank.has(c)).sort((a, b) => rank.get(a)! - rank.get(b)!)
  let k = 0
  return cols.map((c) => (rank.has(c) ? known[k++] : c))
}

/** `cols` (the shown order) with `col` moved to index `to`. */
export function moveColumn(cols: string[], col: string, to: number): string[] {
  const rest = cols.filter((c) => c !== col)
  if (rest.length === cols.length) return cols
  const i = Math.max(0, Math.min(to, rest.length))
  return [...rest.slice(0, i), col, ...rest.slice(i)]
}

/**
 * The saved order after the shown columns were rearranged to `shown`: columns not on screen
 * (hidden, or empty in this sprint) keep their slots, the shown ones fill theirs in the new order.
 */
export function saveColumnOrder(order: string[], shown: string[]): string[] {
  const all = [...order, ...shown.filter((c) => !order.includes(c))]
  let k = 0
  return all.map((c) => (shown.includes(c) ? shown[k++] : c))
}
