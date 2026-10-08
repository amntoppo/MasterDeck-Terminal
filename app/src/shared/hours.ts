import { matchRepo } from './accounts'
import type { AppConfig } from './appConfig'
import { dayOf } from './costs'
import { SPAN_GRAIN, type Span } from './tokens'

/**
 * Working hours per GitHub account, day and ticket, estimated from when sessions were active (the
 * spans of their transcript lines, main/tokens.ts). An estimate from tool activity on this Mac, not
 * a time tracker. Rules (decided on issue #64):
 * - a gap of up to `idleGapMs` between a session's activity counts as working, a longer one not;
 * - an account counts each minute once, however many of its sessions were active then;
 * - a ticket gets its full time, so a minute on two tickets counts for each of them;
 * - a session with no ticket counts for its account only; one with no account under `null`.
 */

export interface HoursSession {
  id: string
  /** GitHub login; null: unknown account. */
  account: string | null
  /** ticketKey; null: no ticket. */
  ticket: string | null
  spans: Span[]
}

export interface HoursOptions {
  idleGapMs: number
  /** YYYY-MM-DD (local), inclusive. */
  from: string
  to: string
}

export interface HoursRow {
  day: string
  account: string | null
  /** null on an account's row. */
  ticket: string | null
  minutes: number
}

export interface HoursResult {
  /** One row per account and day. */
  accounts: HoursRow[]
  /** One row per account, ticket and day. */
  tickets: HoursRow[]
}

/** What main answers per session for the estimate (CH.hoursActivity). */
export interface SessionActivity {
  spans: Span[]
  account: string | null
}

/**
 * The account a session's time goes to: the one recorded at its start, else the account of its
 * folder's repository, else the only account. Never the primary as a guess with two or more: that
 * would put time under the wrong organisation; such a session is an unknown account.
 */
export function hoursAccount(o: { recorded: string | null; origin: string | null }, c: AppConfig): string | null {
  if (o.recorded && c.accounts.some((a) => a.login === o.recorded)) return o.recorded
  const byRepo = o.origin ? matchRepo(o.origin, c) : null
  return byRepo ?? (c.accounts.length === 1 ? c.accounts[0].login : null)
}

export const IDLE_GAPS_MIN = [15, 30, 60, 120] as const
export const DEFAULT_IDLE_GAP_MIN = 60

/** Sorted, with any two closer than `gap` joined. */
export function mergeSpans(spans: Span[], gap: number): Span[] {
  const out: Span[] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** The next local midnight after `t`. */
function nextMidnight(t: number): number {
  const d = new Date(t)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

/** Minutes per local day of these (already merged) intervals. */
export function minutesByDay(spans: Span[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [a, b] of spans) {
    let t = a
    while (t < b) {
      const end = Math.min(b, nextMidnight(t))
      const d = dayOf(t)
      out[d] = (out[d] ?? 0) + (end - t) / 60_000
      t = end
    }
  }
  return out
}

const NONE = '\u0000'
const keyOf = (v: string | null) => v ?? NONE
const valOf = (k: string) => (k === NONE ? null : k)

export function estimateHours(sessions: HoursSession[], opts: HoursOptions): HoursResult {
  // Spans are stored joined within SPAN_GRAIN: a smaller gap could not be told apart.
  const gap = Math.max(opts.idleGapMs, SPAN_GRAIN)
  const byAccount = new Map<string, Span[]>()
  const byTicket = new Map<string, Map<string, Span[]>>()
  for (const s of sessions) {
    // A session's working time: its activity with the idle gaps filled in.
    const work = mergeSpans(s.spans, gap)
    const acct = keyOf(s.account)
    byAccount.set(acct, [...(byAccount.get(acct) ?? []), ...work])
    if (s.ticket === null) continue
    const tickets = byTicket.get(acct) ?? new Map<string, Span[]>()
    byTicket.set(acct, tickets)
    tickets.set(s.ticket, [...(tickets.get(s.ticket) ?? []), ...work])
  }
  const inRange = (d: string) => d >= opts.from && d <= opts.to
  // Union (gap 0): sessions working at the same minute count it once.
  const rows = (spans: Span[], account: string, ticket: string | null): HoursRow[] =>
    Object.entries(minutesByDay(mergeSpans(spans, 0)))
      .filter(([d, m]) => inRange(d) && m > 0)
      .map(([day, minutes]) => ({ day, account: valOf(account), ticket, minutes }))
  const accounts = [...byAccount].flatMap(([a, spans]) => rows(spans, a, null))
  const tickets = [...byTicket].flatMap(([a, m]) => [...m].flatMap(([t, spans]) => rows(spans, a, t)))
  return { accounts: sortRows(accounts), tickets: sortRows(tickets) }
}

/** Newest day first, then account, then ticket. */
function sortRows(rows: HoursRow[]): HoursRow[] {
  const s = (v: string | null) => v ?? '￿'
  return rows.sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : s(a.account).localeCompare(s(b.account)) || s(a.ticket).localeCompare(s(b.ticket))))
}

/** Total minutes per account over the rows. */
export function accountTotals(rows: HoursRow[]): Map<string | null, number> {
  const out = new Map<string | null, number>()
  for (const r of rows) out.set(r.account, (out.get(r.account) ?? 0) + r.minutes)
  return out
}

export const UNKNOWN_ACCOUNT = 'unknown account'
export const ACCOUNT_TOTAL = '(account total)'

/** `3 h 05 min`, `40 min`. */
export function formatHours(minutes: number): string {
  const m = Math.round(minutes)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

const cell = (v: string) => (/[",\r\n]/.test(v) ?`"${v.replace(/"/g, '""')}"` : v)

/** date,account,ticket,minutes: an account's row per day (ticket `(account total)`), then its tickets'. */
export function hoursCsv(r: HoursResult, ticketLabel: (key: string) => string = (k) => k): string {
  const lines = ['date,account,ticket,minutes']
  for (const a of r.accounts) {
    lines.push([a.day, a.account ?? UNKNOWN_ACCOUNT, ACCOUNT_TOTAL, String(Math.round(a.minutes))].map(cell).join(','))
    for (const t of r.tickets)
      if (t.day === a.day && t.account === a.account) lines.push([t.day, t.account ?? UNKNOWN_ACCOUNT, ticketLabel(t.ticket!), String(Math.round(t.minutes))].map(cell).join(','))
  }
  return lines.join('\n') + '\n'
}
