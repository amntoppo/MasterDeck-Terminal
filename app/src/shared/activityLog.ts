import { asTicket, fullRepo, ticketKey, ticketLabel, type Ticket } from './ticket'
import type { InboxEntry } from './inbox'
import type { Meeting } from './meetings'
import type { NoteChange } from './notes'
import type { SchedRun } from './sched'
import type { TeamPr } from './teamPrs'
import type { AppState, Session } from './types'
import type { UpdateState } from './updates'

/**
 * The Dashboard's activity log (#183): what happened, worked out by comparing two states, plus the
 * pure rules the store and the Timeline card share (coalescing, filtering, day groups, the check
 * of a stored line). Never part of AppState: main keeps the events in `activity.jsonl`.
 */

export type ActivityType =
  | 'session-started' | 'session-finished' | 'session-ended'
  | 'pr-opened' | 'pr-reviewed' | 'pr-merged' | 'pr-closed'
  | 'ticket-moved' | 'commit-pushed'
  | 'schedule-run' | 'meeting' | 'note-added'
  | 'release' | 'needs-you-answered'

export type ActivityTarget =
  | { session: string }
  | { pr: string }
  | { ticket: Ticket }
  | { schedules: true }
  | { note: string }
  | { meeting: string }

export interface ActivityEvent {
  /** `${at}-${random}` */
  id: string
  at: number
  type: ActivityType
  /** A plain sentence: "#42 Fix token refresh moved In Dev → PR Raised". */
  title: string
  /** The second line: "acme board", "api-auth-42". */
  detail?: string
  /** The GitHub account, when known. */
  account?: string
  /** owner/name, when there is one. */
  repo?: string
  /** What it is about, for coalescing: "session:<key>", "pr:<url>", "ticket:<repo#n>", "run:<id>" … */
  subject: string
  target?: ActivityTarget
}

export const ACTIVITY_KEEP_DAYS = 14
export const ACTIVITY_MAX_LINES = 5000
export const ACTIVITY_COALESCE_MS = 15 * 60_000
export const ACTIVITY_LIST_MAX = 1000
export const ACTIVITY_RANGE_MAX_MS = 31 * 86_400_000

export const ACTIVITY_TYPES: readonly ActivityType[] = [
  'session-started', 'session-finished', 'session-ended',
  'pr-opened', 'pr-reviewed', 'pr-merged', 'pr-closed',
  'ticket-moved', 'commit-pushed',
  'schedule-run', 'meeting', 'note-added',
  'release', 'needs-you-answered',
]

export const TYPE_TAG: Record<ActivityType, 'SES' | 'PR' | 'TKT' | 'GIT' | 'RUN' | 'NOTE' | 'YOU'> = {
  'session-started': 'SES',
  'session-finished': 'SES',
  'session-ended': 'SES',
  'pr-opened': 'PR',
  'pr-reviewed': 'PR',
  'pr-merged': 'PR',
  'pr-closed': 'PR',
  'ticket-moved': 'TKT',
  'commit-pushed': 'GIT',
  'schedule-run': 'RUN',
  meeting: 'NOTE',
  'note-added': 'NOTE',
  release: 'RUN',
  'needs-you-answered': 'YOU',
}

export type ActivityGroup = 'sessions' | 'prs' | 'tickets' | 'commits' | 'schedules' | 'notes' | 'you'

/** The Timeline's type chips, in order (All is no group picked). */
export const ACTIVITY_GROUPS: readonly { id: ActivityGroup; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'prs', label: 'PRs' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'commits', label: 'Commits' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'notes', label: 'Meetings and notes' },
  { id: 'you', label: 'Needs you' },
]

// A release is MasterDeck's own news, no chip's kind: it shows under All only.
export const TYPE_GROUP: Record<ActivityType, ActivityGroup | null> = {
  'session-started': 'sessions',
  'session-finished': 'sessions',
  'session-ended': 'sessions',
  'pr-opened': 'prs',
  'pr-reviewed': 'prs',
  'pr-merged': 'prs',
  'pr-closed': 'prs',
  'ticket-moved': 'tickets',
  'commit-pushed': 'commits',
  'schedule-run': 'schedules',
  meeting: 'notes',
  'note-added': 'notes',
  release: null,
  'needs-you-answered': 'you',
}

const HOUR = 3_600_000
const ended = (s: Session['state']) => s === 'done' || s === 'suspended'
const newId = (at: number) => () => `${at}-${Math.random().toString(36).slice(2, 10)}`

/** owner/name from a PR's url (TeamPr.repo is the name alone). */
function prRepo(url: string): string | undefined {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)
  return m ? m[1] : undefined
}

/**
 * What happened between two states, as log events. A restart is not news (`prev` null), and a
 * slice that was still loading, or failed, in either state says nothing: a list that comes back
 * empty is not every session ending.
 *
 * `since` is when this process started: PRs and the board load from the gh cache at launch, so a
 * slice whose `prev` was read before it is stale, and its first fresh read is not news.
 */
export function diffActivity(prev: AppState | null, next: AppState, now: number, since?: number, ids: () => string = newId(now)): ActivityEvent[] {
  if (!prev) return []
  const out: ActivityEvent[] = []
  const add = (e: Omit<ActivityEvent, 'id' | 'at'>, at = now) => {
    const ev: ActivityEvent = { id: ids(), at, ...e }
    for (const k of ['detail', 'account', 'repo', 'target'] as const) if (ev[k] === undefined) delete ev[k]
    out.push(ev)
  }
  const agentsOk = prev.sources.agents === 'ok' && next.sources.agents === 'ok'

  if (agentsOk) {
    const before = new Map(prev.sessions.map((s) => [s.key, s]))
    const current = new Map(next.sessions.map((s) => [s.key, s]))
    const session = (s: Session) => ({ subject: `session:${s.key}`, target: { session: s.key }, account: s.account })
    for (const s of next.sessions) {
      const old = before.get(s.key)
      if (!old) {
        if (!ended(s.state)) add({ type: 'session-started', title: `Session ${s.name} started`, ...session(s) })
      } else if (!ended(old.state) && ended(s.state)) {
        add({ type: 'session-ended', title: `Session ${s.name} ended`, ...session(s) })
      } else if (old.state === 'working' && s.state === 'idle' && !s.busyWith) {
        add({ type: 'session-finished', title: `Session ${s.name} finished its turn`, ...session(s) })
      }
    }
    // Sources.build hides superseded sessions (hideSuperseded) and no mark of it reaches the state,
    // so a key that is gone while its name shows under another key is taken for a copy, not an end.
    const names = new Set(next.sessions.map((s) => s.name))
    for (const s of prev.sessions) {
      if (current.has(s.key) || ended(s.state) || names.has(s.name)) continue
      add({ type: 'session-ended', title: `Session ${s.name} ended`, ...session(s) })
    }
  }

  const fresh = (t: number | null) => t !== null && Number.isFinite(t) && (since === undefined || t >= since)
  // An event that happened more than an hour ago, first seen now, is a late read, not news.
  const recent = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN
    return Number.isFinite(t) ? (now - t <= HOUR ? t : null) : undefined
  }

  if (fresh(prev.teamPrsAt) && next.teamPrsAt !== null) {
    const logins = new Set([next.me, ...(next.ghAccounts ?? []).map((a) => a.login)].filter((l): l is string => !!l).map((l) => l.toLowerCase()))
    // A session's PRs count as the user's work, a teammate's PR a review session follows included.
    const sessionUrls = new Set(next.sessions.flatMap((s) => next.sessionPrs[s.sessionId] ?? []))
    const mine = (p: TeamPr) => logins.has(p.author.toLowerCase()) || sessionUrls.has(p.url)
    const before = new Map(prev.teamPrs.map((p) => [p.url, p]))
    for (const p of next.teamPrs) {
      if (!mine(p)) continue
      const name = `${p.repo}#${p.number} ${p.title}`
      const base = { subject: `pr:${p.url}`, target: { pr: p.url }, account: p.account, repo: prRepo(p.url) }
      const old = before.get(p.url)
      if (!old) {
        // A PR first seen long after it was opened is a first read, not news.
        const created = Date.parse(p.createdAt)
        if (Number.isFinite(created) && now - created <= HOUR) add({ type: 'pr-opened', title: `Opened ${name}`, ...base })
        continue
      }
      if (p.mergedAt && !old.mergedAt) {
        const at = recent(p.mergedAt)
        if (at !== null) add({ type: 'pr-merged', title: `Merged ${name}`, ...base }, at)
      } else if (p.closedAt && !p.mergedAt && !old.closedAt) {
        const at = recent(p.closedAt)
        if (at !== null) add({ type: 'pr-closed', title: `Closed ${name}`, ...base }, at)
      }
      if (p.reviewDecision !== old.reviewDecision && p.reviewDecision === 'APPROVED') add({ type: 'pr-reviewed', title: `${name} was approved`, ...base })
      else if (p.reviewDecision !== old.reviewDecision && p.reviewDecision === 'CHANGES_REQUESTED') add({ type: 'pr-reviewed', title: `Changes were requested on ${name}`, ...base })
      else if (p.reviews.length > old.reviews.length) {
        const who = p.reviews.find((r) => !old.reviews.some((o) => o.login === r.login))?.login
        add({ type: 'pr-reviewed', title: who ? `${who} reviewed ${name}` : `${name} got a review`, ...base })
      }
    }
  }

  // state.board is the selected sprint's board (cached per sprint): a switch of sprint is no move.
  const sameSprint = prev.selectedSprint === next.selectedSprint && prev.board?.sprint === next.board?.sprint
  if (prev.board && next.board && sameSprint && fresh(prev.board.takenAt ? Date.parse(prev.board.takenAt) : null)) {
    const cardKey = (c: { repo?: string | null; number: number; project?: string | null }) => `${ticketKey(c.repo, c.number)}@${c.project ?? ''}`
    const before = new Map(prev.board.cards.filter((c) => !c.derived).map((c) => [cardKey(c), c]))
    for (const c of next.board.cards) {
      if (c.derived) continue
      const old = before.get(cardKey(c))
      if (!old || old.status === c.status) continue
      const board = c.project ? (next.board.projects?.find((p) => p.key === c.project)?.title ?? c.project) : undefined
      add({
        type: 'ticket-moved',
        title: `${ticketLabel(c.repo, c.number)} ${c.title} moved ${old.status ?? 'No status'} → ${c.status ?? 'No status'}`,
        detail: board,
        repo: fullRepo(c.repo) || undefined,
        subject: `ticket:${ticketKey(c.repo, c.number)}`,
        target: { ticket: { repo: c.repo ?? null, number: c.number, project: c.project ?? null } },
      })
    }
  }

  // git is keyed by session id; the subject and target use the session's key, which survives a
  // resume, so nothing is recorded without the session list. Known limits: a branch with no
  // upstream has ahead 0 (a first `git push -u` is not seen), and git is read for visible sessions only.
  for (const [id, g] of agentsOk ? Object.entries(next.git) : []) {
    const old = prev.git[id]
    if (!old || old.ahead <= 0 || g.ahead !== 0 || !g.branch || old.branch !== g.branch || old.dir !== g.dir) continue
    const s = next.sessions.find((x) => x.sessionId === id)
    if (!s) continue
    add({
      type: 'commit-pushed',
      title: `Pushed ${old.ahead} ${old.ahead === 1 ? 'commit' : 'commits'} to ${g.branch}`,
      detail: s.name,
      account: s.account,
      subject: `push:${s.key}:${g.branch}`,
      target: { session: s.key },
    })
  }
  return out
}

export interface ActivityFilter {
  groups?: string[]
  account?: string | null
  repo?: string | null
}

/**
 * The Timeline's filter: each condition set narrows the list (AND); none set keeps everything.
 * Accounts and repositories compare ignoring case, as GitHub does.
 */
export function filterActivity(events: ActivityEvent[], f: ActivityFilter): ActivityEvent[] {
  const groups = f.groups?.length ? new Set(f.groups) : null
  const account = f.account?.toLowerCase()
  const repo = f.repo?.toLowerCase()
  return events.filter((e) => {
    if (groups) {
      const g = TYPE_GROUP[e.type]
      if (!g || !groups.has(g)) return false
    }
    if (account && e.account?.toLowerCase() !== account) return false
    if (repo && e.repo?.toLowerCase() !== repo) return false
    return true
  })
}

/**
 * The Timeline's list with a later read merged in: an event with the same id (a coalesced one,
 * moved later) replaces the old, anything before `from` drops out, newest first, at most `max`.
 */
export function mergeActivity(list: ActivityEvent[], fresh: ActivityEvent[], from = 0, max = ACTIVITY_LIST_MAX): ActivityEvent[] {
  if (!fresh.length) return list
  const byId = new Map(list.map((e) => [e.id, e]))
  for (const e of fresh) byId.set(e.id, e)
  return [...byId.values()]
    .filter((e) => e.at >= from)
    .sort((x, y) => y.at - x.at || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0))
    .slice(0, max)
}

/**
 * Adds `e` to a newest-first list. The same type and subject within 15 minutes of its last event
 * replaces that one (keeping its id) so one session's turns or a PR's flapping make one row.
 */
export function coalesce(list: ActivityEvent[], e: ActivityEvent): ActivityEvent[] {
  const i = list.findIndex((x) => x.type === e.type && x.subject === e.subject)
  let item = e
  let rest = list
  if (i >= 0 && Math.abs(e.at - list[i].at) <= ACTIVITY_COALESCE_MS) {
    item = { ...e, id: list[i].id }
    rest = list.filter((_, j) => j !== i)
  }
  const at = rest.findIndex((x) => x.at <= item.at)
  return at < 0 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)]
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`

/** Newest-first events in local days, labelled Today, Yesterday or "Mon 13 Oct". */
export function activityRows(events: ActivityEvent[], now: number): { key: string; label: string; events: ActivityEvent[] }[] {
  const today = new Date(now)
  const todayKey = dayKey(today)
  const yesterdayKey = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))
  const out: { key: string; label: string; events: ActivityEvent[] }[] = []
  for (const e of events) {
    const d = new Date(e.at)
    const key = dayKey(d)
    const last = out[out.length - 1]
    if (last?.key === key) {
      last.events.push(e)
      continue
    }
    const label = key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday' : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
    out.push({ key, label, events: [e] })
  }
  return out
}

const MAX_TEXT = 300
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, MAX_TEXT) : undefined)

function cleanTarget(v: unknown): ActivityTarget | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if ('session' in o) return text(o.session) ? { session: text(o.session)! } : undefined
  if ('pr' in o) return typeof o.pr === 'string' && o.pr.startsWith('https://github.com/') && o.pr.length <= MAX_TEXT ? { pr: o.pr } : undefined
  if ('ticket' in o) {
    const t = asTicket(o.ticket)
    if (!t) return undefined
    const project = (o.ticket as { project?: unknown }).project
    return { ticket: { ...t, project: typeof project === 'string' && project.length <= 100 ? project : null } }
  }
  if ('schedules' in o) return o.schedules === true ? { schedules: true } : undefined
  if ('note' in o) return text(o.note) ? { note: text(o.note)! } : undefined
  if ('meeting' in o) return text(o.meeting) ? { meeting: text(o.meeting)! } : undefined
  return undefined
}

/** A stored line back as an event, or null. Strings are cut to 300 characters; a bad target is dropped. */
export function cleanEvent(raw: unknown): ActivityEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = text(o.id)
  const title = text(o.title)
  const subject = text(o.subject)
  if (!id || !title || !subject) return null
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null
  if (typeof o.type !== 'string' || !ACTIVITY_TYPES.includes(o.type as ActivityType)) return null
  const e: ActivityEvent = { id, at: o.at, type: o.type as ActivityType, title, subject }
  const detail = text(o.detail)
  if (detail) e.detail = detail
  const account = text(o.account)
  if (account) e.account = account
  const repo = text(o.repo)
  if (repo) e.repo = repo
  const target = cleanTarget(o.target)
  if (target) e.target = target
  return e
}

// The stores' events (main wires each one, in try/catch). Each mapper is pure, for its test.

/** A schedule's run that ended: "Nightly triage ran", "Nightly triage failed: reason". Null while it runs. */
export function runEvent(r: SchedRun, now: number, ids: () => string = newId(now)): ActivityEvent | null {
  if (r.status === 'running') return null
  const how = r.status === 'done' ? 'ran' : r.status
  const reason = r.status !== 'done' && r.reason ? `: ${r.reason}` : ''
  const e: ActivityEvent = { id: ids(), at: now, type: 'schedule-run', title: `${r.scheduleName} ${how}${reason}`,
    // Skips can come every slot while a run goes on: one subject per schedule lets them coalesce.
    subject: r.status === 'skipped' ? `schedskip:${r.scheduleId}` : `run:${r.id}`,
    target: { schedules: true } }
  if (r.sessionName) e.detail = r.sessionName
  return e
}

/**
 * A meeting whose recording ended: "Meeting recorded: Standup (42 min)", or with no title yet "A
 * meeting was recorded (42 min)". It is dated when the recording ended, not when this is called:
 * a recording recovered at launch lands on its own day, and one older than the log keeps (14
 * days) is not logged.
 */
export function meetingEvent(m: Pick<Meeting, 'id' | 'title' | 'started' | 'ended' | 'pausedMs' | 'state' | 'segments'>, now: number, ids: () => string = newId(now)): ActivityEvent | null {
  if (m.ended === null || !Number.isFinite(m.ended)) return null
  if (now - m.ended > ACTIVITY_KEEP_DAYS * 86_400_000) return null
  // An empty recording ("Nothing was recorded.") ends failed with no text: nothing was recorded.
  if (m.state === 'failed' && !m.segments.length) return null
  const min = Math.max(1, Math.round((m.ended - m.started - (m.pausedMs || 0)) / 60_000))
  const title = m.title.trim()
  return {
    id: ids(),
    at: Math.min(m.ended, now),
    type: 'meeting',
    title: title ? `Meeting recorded: ${title} (${min} min)` : `A meeting was recorded (${min} min)`,
    subject: `meeting:${m.id}`,
    target: { meeting: m.id },
  }
}

/**
 * A note that did not exist before: "A note was added", or "A note was added to #42". Notes are
 * private: the event carries the note's id and a ticket's number, never its title, preview or
 * text. A meeting's notes are left out (the meeting's own event says it was recorded).
 */
export function noteEvent(c: NoteChange, now: number, ids: () => string = newId(now)): ActivityEvent | null {
  if (!('meta' in c) || !c.created || c.meta.meeting) return null
  const t = c.meta.ticket
  const e: ActivityEvent = {
    id: ids(),
    at: now,
    type: 'note-added',
    title: t ? `A note was added to ${ticketLabel(t.repo, t.number)}` : 'A note was added',
    subject: `note:${c.id}`,
    target: { note: c.id },
  }
  if (t?.repo) e.repo = t.repo
  return e
}

/**
 * A Needs-you item that closed: its title, and how (an answer, or what changed). Not a dismissed one.
 * `since` is when this process started: an item last seen before it was left by the last run and
 * resolves at launch because it is gone, which is no answer. A meeting's item carries the meeting's
 * title: its subject says so (`meeting-item:`), so `forRemote` can leave the title out.
 */
export function inboxEvent(entry: InboxEntry, now: number, since?: number, ids: () => string = newId(now)): ActivityEvent | null {
  const how = entry.resolvedHow ?? null
  if (entry.state !== 'resolved' || how === 'dismissed') return null
  if (since !== undefined && entry.lastSeen < since) return null
  const item = entry.item
  const subject = item.kind === 'meeting' ? `${MEETING_ITEM}${item.id}` : `inbox:${item.id}`
  const e: ActivityEvent = { id: ids(), at: now, type: 'needs-you-answered', title: item.title || 'A Needs-you item closed', subject }
  if (how) e.detail = how
  const repo = item.ticket ? fullRepo(item.ticket.repo) : ''
  if (repo) e.repo = repo
  if (item.sessionKey) e.target = { session: item.sessionKey }
  else if (item.ticket) e.target = { ticket: { repo: item.ticket.repo ?? null, number: item.ticket.number } }
  return e
}

/**
 * What the updater's state says that the log does not have yet: "Updated to x (from y)" once per
 * version, "MasterDeck x is available" once per offered version. Adds what it returns to `seen`.
 */
export function releaseEvents(s: Pick<UpdateState, 'current' | 'offer' | 'updatedFrom'>, seen: Set<string>, now: number, ids: () => string = newId(now)): ActivityEvent[] {
  const out: ActivityEvent[] = []
  if (s.updatedFrom) {
    const subject = `release:updated:${s.current}`
    if (!seen.has(subject)) {
      seen.add(subject)
      const at = Number.isFinite(s.updatedFrom.at) && s.updatedFrom.at <= now ? s.updatedFrom.at : now
      out.push({ id: ids(), at, type: 'release', title: `Updated to ${s.current} (from ${s.updatedFrom.from})`, subject })
    }
  }
  // Any phase with an offer: an automatic download may go from checking to downloading directly.
  if (s.offer && s.offer.version !== s.current) {
    const subject = `release:offer:${s.offer.version}`
    if (!seen.has(subject)) {
      seen.add(subject)
      out.push({ id: ids(), at: now, type: 'release', title: `MasterDeck ${s.offer.version} is available`, subject })
    }
  }
  return out
}

/**
 * `activity:list`'s answer: two finite times, since ≤ until, at most 31 days apart (else nothing),
 * and for a web tab the events as `forRemote` gives them.
 */
export function activityAnswer(list: (since: number, until: number) => ActivityEvent[], since: unknown, until: unknown, remote: boolean): ActivityEvent[] {
  if (typeof since !== 'number' || typeof until !== 'number' || !Number.isFinite(since) || !Number.isFinite(until)) return []
  if (since > until || until - since > ACTIVITY_RANGE_MAX_MS) return []
  const events = list(since, until)
  return remote ? forRemote(events) : events
}

/** The subject prefix of a meeting's Needs-you item that closed (its title is the meeting's). */
const MEETING_ITEM = 'meeting-item:'

/**
 * The events as a web tab gets them. Meetings are the Mac's only (every meetings channel is blocked
 * for the web), so a meeting's line, and a meeting's Needs-you item that closed, lose their title
 * and target.
 */
export function forRemote(events: ActivityEvent[]): ActivityEvent[] {
  return events.map((e) => {
    if (e.type === 'needs-you-answered' && e.subject.startsWith(MEETING_ITEM)) {
      const { target: _t, detail: _d, ...rest } = e
      return { ...rest, title: 'A meeting item was answered' }
    }
    if (e.type !== 'meeting') return e
    const min = / \((\d+) min\)$/.exec(e.title)?.[1]
    const { target: _t, ...rest } = e
    return { ...rest, title: min ? `A meeting was recorded (${min} min)` : 'A meeting was recorded' }
  })
}
