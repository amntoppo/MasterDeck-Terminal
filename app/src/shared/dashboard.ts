import { dailySpend, dayOf, sessionSpendIn, ticketSpend, type CostBook } from './costs'
import type { InboxActionType, InboxEntry, InboxView } from './inbox'
import type { JanitorRow } from './ipc'
import { ownerOf } from './offers'
import type { SchedList, SchedRun } from './sched'
import type { AutoReviewView } from './autoReview'
import { burndown, type BurnPoint } from './sprintSummary'
import type { TeamPr } from './teamPrs'
import { parseTicket, sameTicket, ticketLabel } from './ticket'
import { midnight, resolveRange } from './timeline'
import { tokenSum, tokensIn, type TokensByDay } from './tokens'
import type { AppState, Board, GhCacheStatus, HookStatus, Issue, Pr, Session, SourceHealth, Sprint, TranscriptTail } from './types'
import type { UpdateState } from './updates'
import type { WatchInfo } from './watches'
import type { PrWatchRow } from './watchPr'
import type { GhAccountStatus } from './accounts'
import { DERIVED_COLUMNS, withoutDerived } from './derivedBoard'
import type { ProcsAll } from './sessionProcs'

/**
 * The Dashboard's cards (#183), worked out from what the renderer already has. Pure: every
 * function takes `now`, so the cards can memo on their slices and tests can pin the clock.
 */

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

// ---------------------------------------------------------------------------------------------
// Needs attention

export type Tier = 'now' | 'soon' | 'ready' | 'info'

/** Where a row leads. `view` and `settings` name the renderer's View and Settings section. */
export type AttentionTarget = { session: string } | { pr: string } | { schedules: true } | { view: string } | { settings: string }

export type AttentionAction =
  | { type: 'inbox'; action: InboxActionType; label: string; primary?: boolean }
  /** `target`: where an Open goes when it is not the item's own target (Open session on a PR). */
  | { type: 'open' | 'review' | 'merge' | 'retry' | 'update'; label: string; primary?: boolean; target?: AttentionTarget }

export interface AttentionItem {
  /** The inbox id, or "pr:<url>:<why>", "run:<id>", "watch:<id>", "watch:pr:<url>", "update:<version>". */
  id: string
  tier: Tier
  rank: number
  title: string
  /** One line. */
  why: string
  /** Since when (ms). */
  at: number
  target: AttentionTarget
  actions: AttentionAction[]
  /** Derived items: what makes it news again after a dismissal (empty for inbox items). */
  fingerprint: string
  /** Needs-you items: acted on through inboxAct. */
  inboxId?: string
  /** A failed run: the schedule Retry runs. */
  scheduleId?: string
}

export interface AttentionList {
  /** At most `max`. */
  items: AttentionItem[]
  /** Everything that needs the user, after dismissals. */
  total: number
  /** How many of `total` are in the now tier. */
  now: number
  more: number
  /** The id of every derived item present, dismissed or not: what `pruneDismissed` keeps. */
  subjects: string[]
}

export interface Dismissal {
  id: string
  fingerprint: string
}

export interface AttentionInput {
  inbox: InboxView
  sessions: Session[]
  prs: Pr[]
  teamPrs: TeamPr[]
  sessionPrs: Record<string, string[]>
  me: string | null
  /** Every connected GitHub account's login (`ghAccounts`). */
  logins: string[]
  watches: WatchInfo[]
  prWatches: PrWatchRow[]
  /** `sched:list`'s answer; null until read. */
  sched: SchedList | null
  /** Null on the web. */
  update: UpdateState | null
  /** This device's dismissals of derived items. */
  dismissed: Dismissal[]
  /** 8 on the desktop, 5 on the phone. */
  max: number
}

const TIER_ORDER: Record<Tier, number> = { now: 0, soon: 1, ready: 2, info: 3 }
export const DISMISSED_MAX = 200

/** What makes a derived item news again after it was dismissed. */
export function fingerprintOf(s: { pr: Pick<TeamPr, 'ci' | 'reviewDecision' | 'unresolvedThreads' | 'updatedAt'> } | { run: Pick<SchedRun, 'id'> } | { watch: { error?: string | null; errorAt?: number | null } } | { update: string }): string {
  if ('pr' in s) return `${s.pr.ci}|${s.pr.reviewDecision}|${s.pr.unresolvedThreads}|${s.pr.updatedAt}`
  if ('run' in s) return s.run.id
  if ('watch' in s) return `${s.watch.error ?? ''}|${s.watch.errorAt ?? ''}`
  return s.update
}

/** Which sources of derived items have been read: a subject missing from one still loading is not gone. */
export interface DismissLoaded {
  /** `sched:list` answered (`run:` items). */
  sched: boolean
  /** The team's PRs were read (`pr:` items). */
  prs: boolean
  /** The update state is known (`update:` items; it never is on the web). */
  update: boolean
}

const ALL_LOADED: DismissLoaded = { sched: true, prs: true, update: true }

/**
 * Dismissals of subjects still present, the newest `DISMISSED_MAX`. A dismissal whose source has
 * not loaded yet is kept: `run:` until the schedules are read, `pr:` until the PRs are, `update:`
 * until the update state is. Monitors (`watch:`) come with every state, so they are pruned always.
 */
export function pruneDismissed(dismissed: Dismissal[], subjects: readonly string[], loaded: DismissLoaded = ALL_LOADED): Dismissal[] {
  const here = new Set(subjects)
  const waiting = (id: string) => (id.startsWith('run:') && !loaded.sched) || (id.startsWith('pr:') && !loaded.prs) || (id.startsWith('update:') && !loaded.update)
  return dismissed.filter((d) => here.has(d.id) || waiting(d.id)).slice(-DISMISSED_MAX)
}

/** owner/name#n from a PR link, else what the record has. */
function prLabel(url: string, repo: string, n: number): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)
  return m ? `${m[1]}/${m[2]}#${m[3]}` : `${repo}#${n}`
}

const lower = (s: string) => s.toLowerCase()
const mineSet = (me: string | null, logins: string[]) => new Set([...(me ? [me] : []), ...logins].map(lower))
const parseAt = (iso: string | null | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : fallback
}
const firstLine = (s: string, max = 140) => {
  const l = (s.split('\n').find((x) => x.trim()) ?? '').trim()
  return l.length > max ? `${l.slice(0, max - 1)}…` : l
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function inboxRow(e: InboxEntry): AttentionItem {
  const it = e.item
  const p = it.priority
  // A failing PR is Now whether the inbox or the team's PRs report it (the derived CI row is Now).
  const tier: Tier = p >= 80 || it.kind === 'ci' ? 'now' : p >= 30 ? 'soon' : 'info'
  const own = it.actions.filter((a) => a.type !== 'dismiss' && a.type !== 'open')
  const main = own.find((a) => a.primary) ?? own[0]
  const actions: AttentionAction[] = []
  if (main) actions.push({ type: 'inbox', action: main.type, label: main.label, ...(main.primary ? { primary: true } : {}) })
  if (it.sessionKey) actions.push({ type: 'open', label: 'Open', target: { session: it.sessionKey } })
  return {
    id: it.id,
    tier,
    rank: p,
    title: it.title,
    why: firstLine(it.body),
    at: e.firstSeen,
    // An item with no session opens Needs you, which lives beside the session list.
    target: it.sessionKey ? { session: it.sessionKey } : { view: 'terminals' },
    actions,
    fingerprint: '',
    inboxId: it.id,
  }
}

type PrReason = 'ci' | 'changes' | 'threads' | 'ready'

/**
 * state.watches also lists every PR watch (`pr:<url>`) and Automate Review tab (`review:<tabId>`)
 * beside the monitors, for Details; the Dashboard reads those from prWatches and autoReview.
 */
const isMonitor = (w: WatchInfo) => !w.id.startsWith('pr:') && !w.id.startsWith('review:')

/** Needs attention: the inbox's open items and what MasterDeck sees itself, one row per subject. */
export function attentionItems(input: AttentionInput, now: number): AttentionList {
  const open = input.inbox.open.filter((e) => e.state === 'open')
  const inboxRows = open.map(inboxRow)
  const derived: AttentionItem[] = []

  // What the inbox already says about a PR: a ci / review offer covers its own PR only, and only
  // its reason (a CI offer leaves "Changes requested" on the same PR, and the session's other PRs).
  const covered = new Map<string, Set<PrReason>>()
  const cover = (url: string, rs: PrReason[]) => {
    const s = covered.get(url) ?? new Set<PrReason>()
    rs.forEach((r) => s.add(r))
    covered.set(url, s)
  }
  for (const e of open) {
    const d = e.item.detail
    if (d.type === 'offer') cover(d.offer.pr.url, d.offer.kind === 'ci' ? ['ci'] : ['changes', 'threads'])
  }

  const mine = mineSet(input.me, input.logins)
  const PR_ROW: Record<PrReason, { tier: Tier; rank: number; title: (l: string, p: TeamPr) => string; why: (p: TeamPr) => string }> = {
    ci: { tier: 'now', rank: 70, title: (l) => `CI failed on your PR ${l}`, why: () => 'CI failing' },
    changes: { tier: 'soon', rank: 55, title: (l) => `Changes requested on ${l}`, why: () => 'Changes requested' },
    threads: { tier: 'soon', rank: 50, title: (l, p) => `${plural(p.unresolvedThreads, 'unresolved thread')} on ${l}`, why: (p) => plural(p.unresolvedThreads, 'unresolved thread') },
    ready: { tier: 'ready', rank: 20, title: (l) => `${l} is ready to merge`, why: () => 'Ready to merge' },
  }
  for (const p of input.teamPrs) {
    if (p.state !== 'open' || p.draft || !mine.has(lower(p.author))) continue
    const reasons: PrReason[] = []
    if (p.ci === 'failure') reasons.push('ci')
    if (p.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes')
    if (p.unresolvedThreads > 0) reasons.push('threads')
    if (p.reviewDecision === 'APPROVED' && (p.ci === 'success' || p.ci === null) && p.unresolvedThreads === 0) reasons.push('ready')
    const skip = covered.get(p.url)
    const left = reasons.filter((r) => !skip?.has(r))
    if (!left.length) continue
    const [top, ...rest] = left
    const label = prLabel(p.url, p.repo, p.number)
    const ref = p.issueRefs?.[0] ?? (p.issues[0] !== undefined ? { repo: null, number: p.issues[0] } : null)
    const asPr = { url: p.url, refsIssue: ref?.number ?? null, refsRepo: ref?.repo ?? null } as Pr
    const owner = ownerOf(asPr, input.sessions, input.sessionPrs)
    const row = PR_ROW[top]
    const actions: AttentionAction[] =
      top === 'ready'
        ? [{ type: 'merge', label: 'Merge…', primary: true }]
        : [{ type: 'open', label: 'Open PR', primary: true, target: { pr: p.url } }, ...(owner ? [{ type: 'open' as const, label: 'Open session', target: { session: owner.key } }] : [])]
    derived.push({
      id: `pr:${p.url}:${top}`,
      tier: row.tier,
      rank: row.rank,
      title: row.title(label, p),
      why: [...rest.map((r) => PR_ROW[r].why(p)), p.title, ...(owner ? [`session ${owner.name}`] : [])].filter(Boolean).join(' · '),
      at: parseAt(p.updatedAt, now),
      target: { pr: p.url },
      actions,
      fingerprint: fingerprintOf({ pr: p }),
    })
  }

  // Review requests: master's sweep (prs) and the team's PRs, once per PR. One fingerprint whatever
  // the source (when it was last updated), so a dismissal holds while either source reports it; a
  // PR the team's read knows as draft or no longer open is left out, also when master lists it.
  const asked = new Map<string, { label: string; title: string; author: string | null; at: number; fp: string }>()
  const team = new Map(input.teamPrs.map((p) => [p.url, p]))
  const reviewFp = (updatedAt: string | null | undefined) => {
    const t = updatedAt ? Date.parse(updatedAt) : NaN
    return Number.isFinite(t) ? String(t) : ''
  }
  for (const p of input.prs) {
    const t = team.get(p.url)
    if (!p.reviewRequested || (t && (t.state !== 'open' || t.draft))) continue
    asked.set(p.url, { label: prLabel(p.url, p.repoFull ?? p.repo, p.number), title: p.title, author: null, at: parseAt(p.updatedAt, now), fp: reviewFp(p.updatedAt) })
  }
  for (const p of input.teamPrs) {
    if (p.state !== 'open' || p.draft || mine.has(lower(p.author)) || !p.requested.some((r) => mine.has(lower(r)))) continue
    asked.set(p.url, { label: prLabel(p.url, p.repo, p.number), title: p.title, author: p.author, at: parseAt(p.updatedAt, now), fp: reviewFp(p.updatedAt) })
  }
  for (const [url, r] of asked)
    derived.push({
      id: `pr:${url}:review`,
      tier: 'soon',
      rank: 45,
      title: `Your review is requested on ${r.label}`,
      why: [r.title, ...(r.author ? [`by ${r.author}`] : [])].filter(Boolean).join(' · '),
      at: r.at,
      target: { pr: url },
      actions: [{ type: 'review', label: 'Review', primary: true }],
      fingerprint: r.fp,
    })

  // A schedule whose latest run failed within a day.
  if (input.sched) {
    const latest = new Map<string, SchedRun>()
    for (const r of input.sched.runs) {
      const have = latest.get(r.scheduleId)
      if (!have || r.startedAt > have.startedAt) latest.set(r.scheduleId, r)
    }
    const schedules = new Map(input.sched.schedules.map((x) => [x.id, x]))
    for (const r of latest.values()) {
      const at = r.endedAt ?? r.startedAt
      // A schedule since deleted has nothing to retry or open.
      const sc = schedules.get(r.scheduleId)
      if (!sc || r.status !== 'failed' || now - at > DAY) continue
      derived.push({
        id: `run:${r.id}`,
        tier: 'soon',
        rank: 42,
        title: `Schedule "${r.scheduleName}" failed`,
        why: r.reason ? firstLine(r.reason) : 'Its last run failed',
        at,
        target: { schedules: true },
        // A disabled schedule is not run again from here: Open shows it.
        actions: sc.enabled ? [{ type: 'retry', label: 'Retry', primary: true }, { type: 'open', label: 'Open' }] : [{ type: 'open', label: 'Open', primary: true }],
        fingerprint: fingerprintOf({ run: r }),
        scheduleId: r.scheduleId,
      })
    }
  }

  // A monitor or PR watch that cannot read its source.
  const bySid = new Map(input.sessions.map((s) => [s.sessionId, s]))
  for (const w of input.watches) {
    if (!w.error || !isMonitor(w)) continue
    const s = bySid.get(w.sessionId)
    derived.push({
      id: `watch:${w.id}`,
      tier: 'soon',
      rank: 40,
      title: `Monitor "${w.description || w.command}" cannot read its source`,
      why: firstLine(w.error),
      at: w.errorAt ?? w.lastEventAt ?? w.startedAt,
      target: s ? { session: s.key } : { view: 'terminals' },
      actions: [{ type: 'open', label: 'Open', primary: true }],
      fingerprint: fingerprintOf({ watch: w }),
    })
  }
  const prInfo = new Map(input.watches.filter((w) => w.id.startsWith('pr:')).map((w) => [w.id.slice(3), w]))
  for (const w of input.prWatches) {
    if (!w.error) continue
    // state.watches carries the same watch as `pr:<url>`, with when its error started.
    const errorAt = prInfo.get(w.url)?.errorAt ?? null
    const t = w.target
    derived.push({
      id: `watch:pr:${w.url}`,
      tier: 'soon',
      rank: 40,
      title: `PR watch "${prLabel(w.url, w.repo, w.number)}" cannot read its source`,
      why: firstLine(w.error),
      at: errorAt ?? w.lastEvent?.at ?? w.startedAt,
      target: t && 'session' in t ? { session: t.session.key } : { view: 'prs' },
      actions: [{ type: 'open', label: 'Open', primary: true }],
      fingerprint: fingerprintOf({ watch: { error: w.error, errorAt } }),
    })
  }

  const u = input.update
  if (u?.offer && u.phase === 'ready')
    derived.push({
      id: `update:${u.offer.version}`,
      tier: 'info',
      rank: 15,
      title: `MasterDeck ${u.offer.version} is ready to install`,
      why: 'Restart MasterDeck to update',
      at: u.offer.publishedAt || now,
      target: { settings: 'updates' },
      actions: [{ type: 'update', label: 'Restart', primary: true }],
      fingerprint: fingerprintOf({ update: u.offer.version }),
    })

  const gone = new Map(input.dismissed.map((d) => [d.id, d.fingerprint]))
  const shown = derived.filter((d) => gone.get(d.id) !== d.fingerprint)
  const all = [...inboxRows, ...shown].sort(
    (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.rank - a.rank || a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const items = all.slice(0, Math.max(0, input.max))
  return { items, total: all.length, now: all.filter((i) => i.tier === 'now').length, more: all.length - items.length, subjects: derived.map((d) => d.id) }
}

// ---------------------------------------------------------------------------------------------
// Now

export interface NowInput {
  sessions: Session[]
  /** By sessionId, as the state keeps them. */
  tails: Record<string, TranscriptTail>
  issues: Issue[]
  board: Board | null
  /** Two or more GitHub accounts: rows carry their account. */
  multi: boolean
  /** `procs:all`; null until read. */
  procs: ProcsAll | null
  watches: WatchInfo[]
  prWatches: PrWatchRow[]
  autoReview: AutoReviewView | null
  sched: SchedList | null
}

export type NowChip = 'working' | 'background' | 'waiting' | 'needs-you'

export interface NowSessionRow {
  key: string
  name: string
  /** Shown only with two or more accounts. */
  account: string | null
  chip: NowChip
  chipLabel: string
  /** When it started (for how long). */
  since: number
  /** "#42 Fix token refresh", or null. */
  ticket: string | null
  lastTool: string | null
  lastToolAt: number | null
}

export interface NowView {
  sessions: NowSessionRow[]
  total: number
  more: number
  /** Null until `procs:all` was read. */
  /** `error`: the read was incomplete ("Processes could not be read: …"); the rows are then not all. */
  procs: { at: number; error: string | null; rows: { key: string; session: string; pid: number; command: string; ports: number[] }[] } | null
  watching: { id: string; label: string; at: number | null; target: AttentionTarget }[]
  nextRuns: { id: string; name: string; at: number; when: string }[]
}

export const NOW_MAX = 6

function nowChip(s: Session): { chip: NowChip; label: string } | null {
  if (s.state === 'working') return { chip: 'working', label: 'Working' }
  if (s.state === 'idle' && s.busyWith) return { chip: 'background', label: 'Background command' }
  if (s.state === 'idle' && s.waitingOn) return { chip: 'waiting', label: `Waiting on ${s.waitingOn}` }
  if (s.state === 'needs-input') return { chip: 'needs-you', label: 'Needs you' }
  return null
}

const CHIP_ORDER: Record<NowChip, number> = { working: 0, background: 1, waiting: 2, 'needs-you': 3 }

/** What is going on: sessions at work, their ports, what is watched, and the next scheduled runs. */
export function nowView(input: NowInput, now: number): NowView {
  const rows: NowSessionRow[] = []
  for (const s of input.sessions) {
    const c = nowChip(s)
    if (!c) continue
    let ticket: string | null = null
    if (s.issue !== null) {
      const t = { repo: s.issueRepo ?? null, number: s.issue }
      const title = input.board?.cards.find((x) => sameTicket(x, t))?.title ?? input.issues.find((x) => sameTicket(x, t))?.title
      ticket = [ticketLabel(t.repo, t.number), title].filter(Boolean).join(' ')
    }
    const tail = input.tails[s.sessionId]
    rows.push({
      key: s.key,
      name: s.name,
      account: input.multi ? (s.account ?? null) : null,
      chip: c.chip,
      chipLabel: c.label,
      since: s.startedAt,
      ticket,
      lastTool: tail?.lastTool ?? null,
      lastToolAt: tail?.lastToolAt ?? null,
    })
  }
  rows.sort((a, b) => CHIP_ORDER[a.chip] - CHIP_ORDER[b.chip] || a.since - b.since || (a.key < b.key ? -1 : 1))

  const live = new Map(input.sessions.filter((s) => s.state !== 'done' && s.state !== 'suspended').map((s) => [s.key, s]))
  const procs = input.procs && {
    at: input.procs.at,
    error: input.procs.error ? `Processes could not be read: ${firstLine(input.procs.error)}` : null,
    rows: Object.entries(input.procs.sessions).flatMap(([key, list]) => {
      const s = live.get(key)
      if (!s) return []
      return list.filter((p) => p.state === 'running' && p.ports.length).map((p) => ({ key, session: s.name, pid: p.pid, command: p.command, ports: p.ports.map((x) => x.port) }))
    }),
  }

  const bySid = new Map(input.sessions.map((s) => [s.sessionId, s]))
  const watching: NowView['watching'] = [
    ...input.prWatches.map((w) => ({ id: `prwatch:${w.url}`, label: `PR watch · ${prLabel(w.url, w.repo, w.number)}`, at: w.lastEvent?.at ?? null, target: { pr: w.url } as AttentionTarget })),
    ...input.watches.filter(isMonitor).map((w) => {
      const s = bySid.get(w.sessionId)
      return { id: `watch:${w.id}`, label: w.description || w.command, at: w.lastEventAt, target: (s ? { session: s.key } : { view: 'terminals' }) as AttentionTarget }
    }),
    ...(input.autoReview?.prs ?? [])
      .filter((p) => p.status === 'queued' || p.status === 'reviewing')
      .map((p) => ({ id: `review:${p.url}`, label: `Reviewing ${p.repo}#${p.number}`, at: p.at, target: { pr: p.url } as AttentionTarget })),
  ]

  const nextRuns = (input.sched?.schedules ?? [])
    .filter((s): s is typeof s & { nextAt: number } => s.enabled && s.nextAt !== null)
    .sort((a, b) => a.nextAt - b.nextAt)
    .slice(0, 3)
    .map((s) => ({ id: s.id, name: s.name, at: s.nextAt, when: relTime(s.nextAt, now) }))

  return { sessions: rows.slice(0, NOW_MAX), total: rows.length, more: Math.max(0, rows.length - NOW_MAX), procs, watching, nextRuns }
}

// ---------------------------------------------------------------------------------------------
// Delivery

export interface DeliveryInput {
  board: Board | null
  boardHistory: Record<string, BurnPoint[]>
  sprints: Sprint[]
  teamPrs: TeamPr[]
  prs: Pr[]
  me: string | null
  logins: string[]
}

export interface ColumnCount {
  name: string
  count: number
}

export type SprintView =
  | { kind: 'none'; text: string }
  | { kind: 'derived'; text: string; total: number; columns: ColumnCount[] }
  | {
      kind: 'board'
      /** The sprint's title; null on a board with no sprint field. */
      title: string | null
      total: number
      columns: ColumnCount[]
      /** Null without a sprint. `left`: remaining today; `planned`: the ideal line today. */
      burndown: { points: { date: string; remaining: number | null; ideal: number }[]; left: number | null; planned: number } | null
    }

export interface DeliveryView {
  sprint: SprintView
  prs: {
    /** Each opens Pull requests on its tab. */
    kpis: { id: 'mine' | 'review' | 'merged' | 'ready'; label: string; value: number; tab: 'mine' | 'review' | 'merged' }[]
    stages: { id: 'draft' | 'review' | 'changes' | 'approved'; label: string; count: number }[]
  }
}

function columnCounts(b: Board, names: readonly string[] = b.columns): { total: number; columns: ColumnCount[] } {
  const counts = new Map(names.map((c) => [c, 0]))
  let other = 0
  for (const c of b.cards) {
    if (c.status !== null && counts.has(c.status)) counts.set(c.status, counts.get(c.status)! + 1)
    else other++
  }
  const columns = [...counts].map(([name, count]) => ({ name, count }))
  if (other) columns.push({ name: 'No status', count: other })
  return { total: b.cards.length, columns }
}

/** The sprint's progress and where my PRs stand. */
export function deliveryView(input: DeliveryInput, now: number): DeliveryView {
  const b = input.board
  let sprint: SprintView
  if (!b) sprint = { kind: 'none', text: 'No board yet. Pick one in Setup, or create a GitHub board.' }
  else if (b.derived?.length && !b.cards.some((c) => !c.derived)) sprint = { kind: 'derived', text: 'No sprint: this account has no GitHub board', ...columnCounts(b, DERIVED_COLUMNS) }
  else {
    const sp = b.sprint ? input.sprints.find((s) => s.title === b.sprint) : undefined
    let bd: Extract<SprintView, { kind: 'board' }>['burndown'] = null
    if (sp) {
      const points = burndown(input.boardHistory[sp.title] ?? [], sp.startDate, sp.duration)
      const today = dayOf(now)
      const upto = points.filter((p) => p.date <= today)
      const at = upto.length ? upto[upto.length - 1] : points[0]
      const seen = [...upto].reverse().find((p) => p.remaining !== null)
      bd = { points, left: seen?.remaining ?? null, planned: Math.round(at?.ideal ?? 0) }
    }
    // Derived cards are in no sprint (as the Summary dialog counts it).
    sprint = { kind: 'board', title: b.sprint, ...columnCounts(withoutDerived(b)), burndown: bd }
  }

  const mine = mineSet(input.me, input.logins)
  const minePrs = input.teamPrs.filter((p) => mine.has(lower(p.author)))
  const open = minePrs.filter((p) => p.state === 'open')
  const asked = new Set(input.prs.filter((p) => p.reviewRequested).map((p) => p.url))
  for (const p of input.teamPrs) if (p.state === 'open' && !mine.has(lower(p.author)) && p.requested.some((r) => mine.has(lower(r)))) asked.add(p.url)
  const merged = minePrs.filter((p) => p.mergedAt && now - parseAt(p.mergedAt, 0) <= 7 * DAY).length
  const ready = open.filter((p) => !p.draft && p.reviewDecision === 'APPROVED' && (p.ci === 'success' || p.ci === null) && p.unresolvedThreads === 0).length
  const draft = open.filter((p) => p.draft)
  const nonDraft = open.filter((p) => !p.draft)
  const changes = nonDraft.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED').length
  const approved = nonDraft.filter((p) => p.reviewDecision === 'APPROVED').length
  return {
    sprint,
    prs: {
      kpis: [
        { id: 'mine', label: 'Mine open', value: open.length, tab: 'mine' },
        { id: 'review', label: 'Waiting on you', value: asked.size, tab: 'review' },
        { id: 'merged', label: 'Merged in 7 days', value: merged, tab: 'merged' },
        { id: 'ready', label: 'Ready to merge', value: ready, tab: 'mine' },
      ],
      stages: [
        { id: 'draft', label: 'Draft', count: draft.length },
        { id: 'review', label: 'In review', count: nonDraft.length - changes - approved },
        { id: 'changes', label: 'Changes requested', count: changes },
        { id: 'approved', label: 'Approved', count: approved },
      ],
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Usage & cost

export interface UsageInput {
  costBook: CostBook
  sessions: Session[]
  hookInfo: AppState['hookInfo']
  ghCache: GhCacheStatus | null
  budgetPerTicketUsd: number
  /** Every connected GitHub account's login: two or more give the per-account table. */
  logins: string[]
  /** `tokensByDay` for the book's session ids; null while it is read. */
  tokensByDay: Record<string, TokensByDay> | null
}

export interface UsageWarning {
  id: string
  text: string
  action: { type: 'session'; key: string; label: string } | { type: 'costs'; label: string } | null
}

export interface UsageView {
  today: { cost: number; tokens: number | null }
  week: { cost: number; tokens: number | null }
  /** Empty with fewer than two accounts. `account` null: Unknown account. Tokens are the week's. */
  accounts: { account: string | null; label: string; today: number; week: number; tokens: number | null }[]
  /** The last 7 days, oldest first, ending today. */
  trend: { date: string; cost: number }[]
  /** The week's top 3; `key` only when the session is listed. */
  top: { sessionId: string; key: string | null; name: string; cost: number }[]
  warnings: UsageWarning[]
}


const clock = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Monday 00:00 of the week `t` is in (local time). */
export function weekStart(t: number): number {
  return midnight(t, -((new Date(t).getDay() + 6) % 7))
}

const article = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a')

/** What sessions cost today and this week, per account, and what got in the way. */
export function usageView(input: UsageInput, now: number): UsageView {
  const today = resolveRange({ preset: 'today' }, now)
  const week = { from: weekStart(now), to: now }
  const toks = (id: string, r: { from: number; to: number }) => (input.tokensByDay ? tokenSum(tokensIn(input.tokensByDay[id], r.from, r.to, now)) : 0)
  const withTokens = input.tokensByDay !== null

  let todayCost = 0
  let weekCost = 0
  let todayTok = 0
  let weekTok = 0
  const perAccount = new Map<string | null, { today: number; week: number; tokens: number }>()
  const perSession: UsageView['top'] = []
  const keys = new Set(input.sessions.map((s) => s.key))
  for (const [id, rec] of Object.entries(input.costBook)) {
    const t = sessionSpendIn(rec, today.from, today.to, now)
    const w = sessionSpendIn(rec, week.from, week.to, now)
    const wt = toks(id, week)
    todayCost += t
    weekCost += w
    todayTok += toks(id, today)
    weekTok += wt
    const acct = rec.account?.toLowerCase() ?? null
    const a = perAccount.get(acct) ?? { today: 0, week: 0, tokens: 0 }
    a.today += t
    a.week += w
    a.tokens += wt
    perAccount.set(acct, a)
    if (w > 0) perSession.push({ sessionId: id, key: keys.has(rec.key) ? rec.key : null, name: rec.name, cost: w })
  }

  let accounts: UsageView['accounts'] = []
  if (input.logins.length >= 2) {
    const known = input.logins.map((login) => {
      const a = perAccount.get(lower(login))
      return { account: login, label: login, today: a?.today ?? 0, week: a?.week ?? 0, tokens: withTokens ? (a?.tokens ?? 0) : null }
    })
    known.sort((x, y) => y.week - x.week || y.today - x.today)
    // Entries with no account, or one no longer connected.
    const listed = new Set(input.logins.map(lower))
    const rest = { today: 0, week: 0, tokens: 0 }
    for (const [k, v] of perAccount)
      if (k === null || !listed.has(k)) {
        rest.today += v.today
        rest.week += v.week
        rest.tokens += v.tokens
      }
    accounts = [...known, ...(rest.week > 0 || rest.today > 0 || rest.tokens > 0 ? [{ account: null, label: 'Unknown account', today: rest.today, week: rest.week, tokens: withTokens ? rest.tokens : null }] : [])]
  }

  const daily = dailySpend(input.costBook)
  const trend = Array.from({ length: 7 }, (_, i) => {
    const date = dayOf(midnight(now, i - 6))
    return { date, cost: daily[date] ?? 0 }
  })

  const warnings: UsageWarning[] = []
  for (const s of input.sessions) {
    const f = input.hookInfo[s.key]?.failure
    if (!f || now - f.at > DAY) continue
    const what = f.type.replace(/_/g, ' ')
    warnings.push({ id: `failure:${s.key}`, text: `${s.name} stopped on ${article(what)} ${what} ${relTime(f.at, now)}`, action: { type: 'session', key: s.key, label: 'Open session' } })
  }
  const g = input.ghCache
  if (g?.pausedUntil && g.pausedUntil > now) warnings.push({ id: 'gh-paused', text: `GitHub is paused until ${clock(g.pausedUntil)} (${g.pauseReason || 'rate limit'})`, action: null })
  const cap = input.budgetPerTicketUsd
  if (cap > 0) {
    const over = Object.entries(ticketSpend(input.costBook))
      .filter(([, v]) => v > cap)
      .map(([k]) => parseTicket(k))
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map((t) => ticketLabel(t.repo, t.number))
    if (over.length)
      warnings.push({ id: 'budget', text: `${plural(over.length, 'ticket is', 'tickets are')} over the $${cap} budget: ${over.join(', ')}`, action: { type: 'costs', label: 'Costs' } })
  }

  return {
    today: { cost: todayCost, tokens: withTokens ? todayTok : null },
    week: { cost: weekCost, tokens: withTokens ? weekTok : null },
    accounts,
    trend,
    top: perSession.sort((a, b) => b.cost - a.cost).slice(0, 3),
    warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// Health

export type HealthStatus = 'ok' | 'warn' | 'bad' | 'unknown'

export type HealthAction =
  | { type: 'settings'; section: string; label: string }
  | { type: 'view'; view: string; label: string }
  | { type: 'show-strays'; label: string }
  | { type: 'check-worktrees'; label: string }
  | { type: 'update'; label: string }

export interface HealthRow {
  id: 'remote' | 'github' | 'claude' | 'hooks' | 'errors' | 'strays' | 'worktrees' | 'masterdeck'
  status: HealthStatus
  label: string
  detail: string
  action?: HealthAction
  /** The strays row: the list Show expands. */
  strays?: ProcsAll['strays']
}

export interface HealthInput {
  now: number
  remoteEnabled: boolean
  remote: AppState['remote']
  browsers: NonNullable<AppState['browsers']>
  /** Undefined until the first account status. */
  ghAccounts: GhAccountStatus[] | undefined
  ghCache: GhCacheStatus | null
  boardError: string | null
  teamPrsError: string | null
  sources: Record<string, SourceHealth>
  errors: string[]
  missingBinaries: string[]
  hooks: HookStatus
  statuslineInstalled: boolean
  /** `procs:all`; null: not read yet. */
  procs: ProcsAll | null
  /** The janitor's answer; null: not checked yet. */
  janitor: JanitorRow[] | null
  /** Processes are not read on Windows. */
  windows: boolean
  /** Null on the web: the row is left out. */
  update: UpdateState | null
}

export interface HealthView {
  rows: HealthRow[]
  /** Every row is ok: the card shows All good and keeps the rows under Details. */
  allGood: boolean
  /** "All good", "2 problems", or "No problems found" while something is not checked. */
  summary: string
}

const strayName = (command: string) => {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return first.split('/').pop() || command
}

/** One row per thing that can be wrong, each ok, warn, bad or not known. */
export function healthView(input: HealthInput): HealthView {
  const rows: HealthRow[] = []

  // Remote
  {
    const r = input.remote
    const label = 'Remote'
    if (!input.remoteEnabled) rows.push({ id: 'remote', status: 'ok', label, detail: 'Off' })
    else if (!r) rows.push({ id: 'remote', status: 'unknown', label, detail: 'Not started yet' })
    else if (r.conn === 'connected') {
      const n = input.browsers.filter((b) => b.connected).length
      rows.push({ id: 'remote', status: 'ok', label, detail: n ? `Connected · ${plural(n, 'browser')}` : 'Connected' })
    } else if (r.conn === 'connecting') rows.push({ id: 'remote', status: 'warn', label, detail: 'Connecting…' })
    else if (r.conn === 'error') rows.push({ id: 'remote', status: 'bad', label, detail: r.message || 'Cannot connect' })
    else rows.push({ id: 'remote', status: 'bad', label, detail: r.message || 'Off, though it is turned on in Settings' })
  }

  // GitHub
  {
    const label = 'GitHub'
    const accts = input.ghAccounts
    const sick = accts?.find((a) => !a.healthy)
    const paused = input.ghCache?.pausedUntil && input.ghCache.pausedUntil > input.now ? input.ghCache : null
    if (sick) rows.push({ id: 'github', status: 'bad', label, detail: `${sick.login}: ${sick.error || 'needs to log in again'}` })
    else if (paused) rows.push({ id: 'github', status: 'warn', label, detail: `Paused until ${clock(paused.pausedUntil!)} (${paused.pauseReason || 'rate limit'})` })
    else if (input.boardError) rows.push({ id: 'github', status: 'warn', label, detail: `The board cannot be read: ${firstLine(input.boardError)}` })
    else if (input.teamPrsError) rows.push({ id: 'github', status: 'warn', label, detail: `Pull requests cannot be read: ${firstLine(input.teamPrsError)}` })
    else if (!accts) rows.push({ id: 'github', status: 'unknown', label, detail: 'Accounts not read yet' })
    else if (!accts.length) rows.push({ id: 'github', status: 'warn', label, detail: 'No account connected' })
    else rows.push({ id: 'github', status: 'ok', label, detail: `${plural(accts.length, 'account')} connected` })
  }

  // Claude
  {
    const label = 'Claude'
    const agents = input.sources.agents
    if (input.missingBinaries.length) rows.push({ id: 'claude', status: 'bad', label, detail: `Not installed: ${input.missingBinaries.join(', ')}` })
    else if (agents === 'error')
      rows.push({ id: 'claude', status: 'bad', label, detail: firstLine(input.errors.find((e) => /agents|claude/i.test(e)) ?? "Claude Code's session list cannot be read") })
    else if (agents !== 'ok') rows.push({ id: 'claude', status: 'unknown', label, detail: 'Loading the session list…' })
    else rows.push({ id: 'claude', status: 'ok', label, detail: 'Sessions are listed' })
  }

  // Hooks and status line
  {
    // MasterDeck installs no deck hooks on Windows. The status line is optional (it can be removed
    // in Settings), so its absence alone is no problem: the row only says so.
    const w = input.windows
    const missing = [
      ...(w || input.hooks.queue ? [] : ['the /queue hook']),
      ...(w || input.hooks.reviewGate ? [] : ['the self-review gate']),
      ...(w || input.hooks.masterGuard ? [] : ['the master reports guard']),
    ]
    rows.push(
      missing.length
        ? { id: 'hooks', status: 'warn', label: 'Hooks and status line', detail: `Not installed: ${missing.join(', ')}`, action: { type: 'settings', section: 'hooks', label: 'Fix' } }
        : { id: 'hooks', status: 'ok', label: 'Hooks and status line', detail: input.statuslineInstalled ? 'Installed' : w ? 'Status line off' : 'Installed · status line off' },
    )
  }

  // Errors
  {
    const e = input.errors
    rows.push(e.length ? { id: 'errors', status: 'warn', label: 'Errors', detail: `${firstLine(e[0])}${e.length > 1 ? `, and ${e.length - 1} more` : ''}` } : { id: 'errors', status: 'ok', label: 'Errors', detail: 'None' })
  }

  // Stray processes
  {
    const label = 'Stray processes'
    const p = input.procs
    if (input.windows) rows.push({ id: 'strays', status: 'unknown', label, detail: 'Not available on Windows' })
    else if (!p) rows.push({ id: 'strays', status: 'unknown', label, detail: 'Not checked' })
    else if (p.error && !p.strays.length) rows.push({ id: 'strays', status: 'warn', label, detail: `Could not be read: ${firstLine(p.error)}` })
    else if (!p.strays.length) rows.push({ id: 'strays', status: 'ok', label, detail: 'None found' })
    else {
      const s = p.strays[0]
      const port = s.ports[0] ? ` :${s.ports[0].port}` : ''
      const more = p.strays.length > 1 ? `, and ${p.strays.length - 1} more` : ''
      const partial = p.error ? ' (the read was incomplete)' : ''
      // A stray sits in a session's folder but below no running session: a finished session left
      // it, or someone started it by hand there.
      const where = s.folderOf ? ` in ${s.folderOf.split(/[\\/]/).filter(Boolean).pop() ?? s.folderOf}` : ''
      rows.push({ id: 'strays', status: 'warn', label, detail: `${strayName(s.command)}${port}${where}, not started by a session${more}${partial}`, action: { type: 'show-strays', label: 'Show' }, strays: p.strays })
    }
  }

  // Worktrees
  {
    const label = 'Worktrees'
    const j = input.janitor
    if (!j) rows.push({ id: 'worktrees', status: 'unknown', label, detail: 'Not checked', action: { type: 'check-worktrees', label: 'Check worktrees' } })
    else {
      const safe = j.filter((r) => r.cls === 'SAFE').length
      rows.push(safe ? { id: 'worktrees', status: 'warn', label, detail: `${safe} can be removed`, action: { type: 'view', view: 'janitor', label: 'Janitor' } } : { id: 'worktrees', status: 'ok', label, detail: 'Nothing to remove' })
    }
  }

  // MasterDeck (the window only)
  const u = input.update
  if (u) {
    const label = 'MasterDeck'
    const v = u.offer?.version
    if (u.phase === 'error') rows.push({ id: 'masterdeck', status: 'bad', label, detail: `Update failed: ${firstLine(u.error || 'unknown error')}` })
    else if (u.phase === 'ready' && v) rows.push({ id: 'masterdeck', status: 'warn', label, detail: `${v} is ready to install`, action: { type: 'update', label: 'Restart to update' } })
    else if (v && (u.phase === 'available' || u.phase === 'downloading' || u.phase === 'verifying')) rows.push({ id: 'masterdeck', status: 'warn', label, detail: `${v} is available` })
    else if (!u.enabled) rows.push({ id: 'masterdeck', status: 'ok', label, detail: u.current })
    else if (u.phase === 'checking') rows.push({ id: 'masterdeck', status: 'ok', label, detail: `${u.current}, checking for updates…` })
    else if (u.phase === 'installing') rows.push({ id: 'masterdeck', status: 'warn', label, detail: v ? `Installing ${v}…` : 'Installing an update…' })
    else if (u.phase === 'idle') rows.push({ id: 'masterdeck', status: 'ok', label, detail: u.current })
    else rows.push({ id: 'masterdeck', status: 'ok', label, detail: `${u.current}, up to date` })
  }

  const problems = rows.filter((r) => r.status === 'warn' || r.status === 'bad').length
  const allGood = rows.every((r) => r.status === 'ok')
  return { rows, allGood, summary: problems ? plural(problems, 'problem') : allGood ? 'All good' : 'No problems found' }
}

// ---------------------------------------------------------------------------------------------
// Times

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A time in words, past or future: "just now", "5 min ago", "2 h ago", "yesterday 18:05",
 * "Mon 09:30", "3 Oct 09:30"; "in 20 min", "today 17:30", "tonight 02:00", "tomorrow 09:30".
 * Not formatRefreshed: the Dashboard's rows want the short "min" / "h" and clock times.
 */
export function relTime(at: number, now: number): string {
  const days = Math.round((midnight(at) - midnight(now)) / DAY) // calendar days apart (DST-safe)
  const d = new Date(at)
  const hm = clock(at)
  const dated = `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`
  if (at <= now) {
    const m = Math.floor((now - at) / MIN)
    if (m < 1) return 'just now'
    if (m < 60) return `${m} min ago`
    if (days === 0) return `${Math.floor((now - at) / HOUR)} h ago`
    if (days === -1) return `yesterday ${hm}`
    if (days >= -6) return `${WEEKDAYS[d.getDay()]} ${hm}`
    return dated
  }
  const m = Math.floor((at - now) / MIN)
  if (m < 1) return 'in a moment'
  if (m < 60) return `in ${m} min`
  if (days === 0) return `${d.getHours() >= 18 ? 'tonight' : 'today'} ${hm}`
  if (days === 1) return `${d.getHours() < 6 ? 'tonight' : 'tomorrow'} ${hm}`
  if (days <= 6) return `${WEEKDAYS[d.getDay()]} ${hm}`
  return dated
}
