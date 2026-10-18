import { asTicket, fullRepo, ticketKey, ticketLabel, type Ticket } from './ticket'
import type { TeamPr } from './teamPrs'
import type { AppState, Session } from './types'

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
 */
export function diffActivity(prev: AppState | null, next: AppState, now: number, ids: () => string = newId(now)): ActivityEvent[] {
  if (!prev) return []
  const out: ActivityEvent[] = []
  const add = (e: Omit<ActivityEvent, 'id' | 'at'>) => {
    const ev: ActivityEvent = { id: ids(), at: now, ...e }
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

  if (prev.teamPrsAt !== null && next.teamPrsAt !== null) {
    const logins = new Set([next.me, ...(next.ghAccounts ?? []).map((a) => a.login)].filter((l): l is string => !!l).map((l) => l.toLowerCase()))
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
      if (p.mergedAt && !old.mergedAt) add({ type: 'pr-merged', title: `Merged ${name}`, ...base })
      else if (p.closedAt && !p.mergedAt && !old.closedAt) add({ type: 'pr-closed', title: `Closed ${name}`, ...base })
      if (p.reviewDecision !== old.reviewDecision && p.reviewDecision === 'APPROVED') add({ type: 'pr-reviewed', title: `${name} was approved`, ...base })
      else if (p.reviewDecision !== old.reviewDecision && p.reviewDecision === 'CHANGES_REQUESTED') add({ type: 'pr-reviewed', title: `Changes were requested on ${name}`, ...base })
      else if (p.reviews.length > old.reviews.length) {
        const who = p.reviews.find((r) => !old.reviews.some((o) => o.login === r.login))?.login
        add({ type: 'pr-reviewed', title: who ? `${who} reviewed ${name}` : `${name} got a review`, ...base })
      }
    }
  }

  if (prev.board && next.board) {
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

  // git is keyed by session id; the subject and target use the session's key, which survives a resume.
  for (const [id, g] of Object.entries(next.git)) {
    const old = prev.git[id]
    if (!old || old.ahead <= 0 || g.ahead !== 0 || !g.branch || old.branch !== g.branch || old.dir !== g.dir) continue
    const s = next.sessions.find((x) => x.sessionId === id)
    const key = s?.key ?? id
    add({
      type: 'commit-pushed',
      title: `Pushed ${old.ahead} ${old.ahead === 1 ? 'commit' : 'commits'} to ${g.branch}`,
      detail: s?.name,
      account: s?.account,
      subject: `push:${key}:${g.branch}`,
      target: { session: key },
    })
  }
  return out
}

export interface ActivityFilter {
  groups?: string[]
  account?: string | null
  repo?: string | null
}

/** The Timeline's filter: each condition set narrows the list (AND); none set keeps everything. */
export function filterActivity(events: ActivityEvent[], f: ActivityFilter): ActivityEvent[] {
  const groups = f.groups?.length ? new Set(f.groups) : null
  return events.filter((e) => {
    if (groups) {
      const g = TYPE_GROUP[e.type]
      if (!g || !groups.has(g)) return false
    }
    if (f.account && e.account !== f.account) return false
    if (f.repo && e.repo !== f.repo) return false
    return true
  })
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
    if (item.detail === undefined) delete item.detail
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
