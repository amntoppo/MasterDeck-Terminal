import { ticketKey } from './ticket'
import { bucketShare } from './timeline'

/**
 * Cost history from the status line stats. A session's `total_cost_usd` is cumulative, so for
 * each session we keep the highest value seen per bucket (a local clock hour, `YYYY-MM-DDTHH`; a day
 * before #88 or once a month old, see shared/timeline.ts); a bucket's spend is its maximum minus the
 * maximum of the latest earlier bucket. A resumed session gets a new session id and starts
 * again from its own zero, so each id is accounted separately and nothing goes negative.
 */

export interface CostEntry {
  sessionId: string
  name: string
  key: string
  issue: number | null
  /** The issue's repo (owner/name); null or missing: the primary issue repo. */
  issueRepo?: string | null
  cost: number
  /** When the session started (epoch ms), if known. */
  startedAt?: number | null
  /** The GitHub account the session works as, if known (`Session.account`). */
  account?: string
}

/**
 * Cost a session had already run up when first seen (it started before today, or we can't
 * tell). It counts toward all-time and ticket totals, but not toward any single day.
 */
export const BASELINE = '0000-baseline'

export interface SessionCost {
  name: string
  key: string
  issue: number | null
  issueRepo?: string | null
  /** The session's GitHub account, the latest one seen; missing: not known. */
  account?: string
  /** Bucket (YYYY-MM-DDTHH, or YYYY-MM-DD) → highest cumulative cost seen in it. */
  days: Record<string, number>
}

export type CostBook = Record<string, SessionCost>

export function dayOf(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Record the latest cumulative cost of each session under `bucket` (the hour, `hourOf`). A session
 * seen for the first time that started before `dayStartMs` gets its cost as a baseline instead, so a
 * first launch doesn't report every session's lifetime spend as today's. Returns true when anything
 * changed.
 * ponytail: a session first seen after it started today puts what it spent so far in this hour; a
 * finer split would need its transcript's tokens priced per model.
 */
export function recordCosts(book: CostBook, entries: CostEntry[], bucket: string, dayStartMs?: number): boolean {
  let changed = false
  for (const e of entries) {
    if (!(e.cost >= 0)) continue
    if (!book[e.sessionId] && dayStartMs !== undefined && (e.startedAt == null || e.startedAt < dayStartMs)) {
      book[e.sessionId] = { name: e.name, key: e.key, issue: e.issue, ...(e.issueRepo ? { issueRepo: e.issueRepo } : {}), ...(e.account ? { account: e.account } : {}), days: { [BASELINE]: e.cost } }
      changed = true
      continue
    }
    const rec = (book[e.sessionId] ??= { name: e.name, key: e.key, issue: e.issue, ...(e.issueRepo ? { issueRepo: e.issueRepo } : {}), ...(e.account ? { account: e.account } : {}), days: {} })
    if (rec.name !== e.name || rec.issue !== e.issue || (rec.issueRepo ?? null) !== (e.issueRepo ?? null) || rec.key !== e.key) {
      rec.name = e.name
      rec.key = e.key
      if (e.issue !== null) {
        rec.issue = e.issue
        if (e.issueRepo) rec.issueRepo = e.issueRepo
        else delete rec.issueRepo
      }
      changed = true
    }
    // An entry without an account keeps the one seen before (the session may have left the list).
    if (e.account && rec.account !== e.account) {
      rec.account = e.account
      changed = true
    }
    if ((rec.days[bucket] ?? -1) < e.cost) {
      rec.days[bucket] = e.cost
      changed = true
    }
  }
  return changed
}

/** Spend per bucket for one session. */
function perBucket(rec: SessionCost): Record<string, number> {
  const out: Record<string, number> = {}
  let prev = 0
  for (const d of Object.keys(rec.days).sort()) {
    const v = rec.days[d]
    out[d] = Math.max(0, v - prev)
    prev = Math.max(prev, v)
  }
  return out
}

/** Total spend per bucket across sessions (the baseline is not a bucket). */
export function bucketSpend(book: CostBook): Record<string, number> {
  const out: Record<string, number> = {}
  for (const rec of Object.values(book))
    for (const [b, v] of Object.entries(perBucket(rec))) if (b !== BASELINE) out[b] = (out[b] ?? 0) + v
  return out
}

/** Total spend per day across sessions (the baseline is not a day). */
export function dailySpend(book: CostBook): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [b, v] of Object.entries(bucketSpend(book))) out[b.slice(0, 10)] = (out[b.slice(0, 10)] ?? 0) + v
  return out
}

/** Spend in [from, to) (epoch ms) of spend per bucket (`bucketSpend`, or one session's). */
export function spendIn(byBucket: Record<string, number>, from: number, to: number, now: number): number {
  let sum = 0
  for (const [b, v] of Object.entries(byBucket)) if (v > 0) sum += v * bucketShare(b, from, to, now)
  return sum
}

/** Spend in [from, to) (epoch ms) of one session. */
export function sessionSpendIn(rec: SessionCost, from: number, to: number, now: number): number {
  return spendIn(perBucket(rec), from, to, now)
}

/** All-time spend of one session (its highest cumulative cost). */
export function sessionTotal(rec: SessionCost): number {
  return Math.max(0, ...Object.values(rec.days))
}

/** Spend within [from, to] (YYYY-MM-DD, inclusive) of one session. */
export function sessionSpendBetween(rec: SessionCost, from: string, to: string): number {
  return Object.entries(perBucket(rec))
    .filter(([b]) => b.slice(0, 10) >= from && b.slice(0, 10) <= to)
    .reduce((a, [, v]) => a + v, 0)
}

/** All-time spend per ticket (by ticketKey): the sum of its sessions' totals. */
export function ticketSpend(book: CostBook): Record<string, number> {
  const out: Record<string, number> = {}
  for (const rec of Object.values(book)) {
    if (rec.issue === null) continue
    const k = ticketKey(rec.issueRepo, rec.issue)
    out[k] = (out[k] ?? 0) + sessionTotal(rec)
  }
  return out
}

/**
 * Fold hours older than `hourDays` before `today` into their day (keeps the book small: the state
 * carries it), and drop days older than `keepDays`. A fold keeps the highest cumulative cost, so
 * later spend and the all-time total stay right; dropped days go into the baseline.
 */
export function pruneBook(book: CostBook, today: string, keepDays = 120, hourDays = 35): void {
  const cutoff = dayOf(Date.parse(today) - keepDays * 86_400_000)
  const hourCutoff = dayOf(Date.parse(today) - hourDays * 86_400_000)
  for (const rec of Object.values(book)) {
    for (const b of Object.keys(rec.days)) {
      const day = b.slice(0, 10)
      if (b.length > 10 && b !== BASELINE && day < hourCutoff) {
        rec.days[day] = Math.max(rec.days[day] ?? 0, rec.days[b])
        delete rec.days[b]
      }
    }
    let folded = rec.days[BASELINE] ?? 0
    let dropped = false
    for (const d of Object.keys(rec.days)) {
      if (d !== BASELINE && d < cutoff) {
        folded = Math.max(folded, rec.days[d])
        delete rec.days[d]
        dropped = true
      }
    }
    if (dropped) rec.days[BASELINE] = folded
  }
}

/** A GitHub login: 1 to 39 characters. */
function validAccount(a: unknown): a is string {
  return typeof a === 'string' && a.length > 0 && a.length <= 39
}

/** Keep only well-formed records from a costs file (anything else would crash the math). */
export function validBook(raw: unknown): CostBook {
  const out: CostBook = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, r] of Object.entries(raw as Record<string, unknown>)) {
    const rec = r as Partial<SessionCost> | null
    if (!rec || typeof rec !== 'object' || !rec.days || typeof rec.days !== 'object') continue
    const days: Record<string, number> = {}
    for (const [d, v] of Object.entries(rec.days)) if (typeof v === 'number' && Number.isFinite(v)) days[d] = v
    out[id] = { name: typeof rec.name === 'string' ? rec.name : id.slice(0, 8), key: typeof rec.key === 'string' ? rec.key : id, issue: typeof rec.issue === 'number' ? rec.issue : null, ...(typeof rec.issueRepo === 'string' ? { issueRepo: rec.issueRepo } : {}), ...(validAccount(rec.account) ? { account: rec.account } : {}), days }
  }
  return out
}

export function sumBetween(daily: Record<string, number>, from: string, to: string): number {
  return Object.entries(daily)
    .filter(([d]) => d >= from && d <= to)
    .reduce((a, [, v]) => a + v, 0)
}
