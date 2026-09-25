/**
 * Cost history from the status line stats. A session's `total_cost_usd` is cumulative, so for
 * each session we keep the highest value seen per day; a day's spend is that day's maximum minus
 * the maximum of the latest earlier day. A resumed session gets a new session id and starts
 * again from its own zero, so each id is accounted separately and nothing goes negative.
 */

export interface CostEntry {
  sessionId: string
  name: string
  key: string
  issue: number | null
  cost: number
  /** When the session started (epoch ms), if known. */
  startedAt?: number | null
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
  /** YYYY-MM-DD → highest cumulative cost seen that day. */
  days: Record<string, number>
}

export type CostBook = Record<string, SessionCost>

export function dayOf(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Record the latest cumulative cost of each session under `day`. A session seen for the first time
 * that started before `dayStartMs` gets its cost as a baseline instead, so a first launch doesn't
 * report every session's lifetime spend as today's. Returns true when anything changed.
 */
export function recordCosts(book: CostBook, entries: CostEntry[], day: string, dayStartMs?: number): boolean {
  let changed = false
  for (const e of entries) {
    if (!(e.cost >= 0)) continue
    if (!book[e.sessionId] && dayStartMs !== undefined && (e.startedAt == null || e.startedAt < dayStartMs)) {
      book[e.sessionId] = { name: e.name, key: e.key, issue: e.issue, days: { [BASELINE]: e.cost } }
      changed = true
      continue
    }
    const rec = (book[e.sessionId] ??= { name: e.name, key: e.key, issue: e.issue, days: {} })
    if (rec.name !== e.name || rec.issue !== e.issue || rec.key !== e.key) {
      rec.name = e.name
      rec.key = e.key
      if (e.issue !== null) rec.issue = e.issue
      changed = true
    }
    if ((rec.days[day] ?? -1) < e.cost) {
      rec.days[day] = e.cost
      changed = true
    }
  }
  return changed
}

/** Spend per day for one session. */
function perDay(rec: SessionCost): Record<string, number> {
  const out: Record<string, number> = {}
  let prev = 0
  for (const d of Object.keys(rec.days).sort()) {
    const v = rec.days[d]
    out[d] = Math.max(0, v - prev)
    prev = Math.max(prev, v)
  }
  return out
}

/** Total spend per day across sessions (the baseline is not a day). */
export function dailySpend(book: CostBook): Record<string, number> {
  const out: Record<string, number> = {}
  for (const rec of Object.values(book))
    for (const [d, v] of Object.entries(perDay(rec))) if (d !== BASELINE) out[d] = (out[d] ?? 0) + v
  return out
}

/** All-time spend of one session (its highest cumulative cost). */
export function sessionTotal(rec: SessionCost): number {
  return Math.max(0, ...Object.values(rec.days))
}

/** Spend within [from, to] (YYYY-MM-DD, inclusive) of one session. */
export function sessionSpendBetween(rec: SessionCost, from: string, to: string): number {
  return Object.entries(perDay(rec))
    .filter(([d]) => d >= from && d <= to)
    .reduce((a, [, v]) => a + v, 0)
}

/** All-time spend per ticket: the sum of its sessions' totals. */
export function ticketSpend(book: CostBook): Record<number, number> {
  const out: Record<number, number> = {}
  for (const rec of Object.values(book)) if (rec.issue !== null) out[rec.issue] = (out[rec.issue] ?? 0) + sessionTotal(rec)
  return out
}

/**
 * Drop days older than `keepDays` before `today`. The dropped days' highest cumulative cost folds
 * into the baseline, so later days' spend and the all-time total stay right.
 */
export function pruneBook(book: CostBook, today: string, keepDays = 120): void {
  const cutoff = dayOf(Date.parse(today) - keepDays * 86_400_000)
  for (const rec of Object.values(book)) {
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

/** Keep only well-formed records from a costs file (anything else would crash the math). */
export function validBook(raw: unknown): CostBook {
  const out: CostBook = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, r] of Object.entries(raw as Record<string, unknown>)) {
    const rec = r as Partial<SessionCost> | null
    if (!rec || typeof rec !== 'object' || !rec.days || typeof rec.days !== 'object') continue
    const days: Record<string, number> = {}
    for (const [d, v] of Object.entries(rec.days)) if (typeof v === 'number' && Number.isFinite(v)) days[d] = v
    out[id] = { name: typeof rec.name === 'string' ? rec.name : id.slice(0, 8), key: typeof rec.key === 'string' ? rec.key : id, issue: typeof rec.issue === 'number' ? rec.issue : null, days }
  }
  return out
}

export function sumBetween(daily: Record<string, number>, from: string, to: string): number {
  return Object.entries(daily)
    .filter(([d]) => d >= from && d <= to)
    .reduce((a, [, v]) => a + v, 0)
}
