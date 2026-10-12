import { bucketShare, hourOf } from './timeline'

/**
 * Tokens a session used, summed from its transcripts: every assistant message carries a `usage`
 * block. Claude Code writes a message more than once as it streams (same message id, same usage),
 * so each id counts once. Tokens are kept per local clock hour of the message's own timestamp, like
 * costs (`YYYY-MM-DDTHH`; a tally from before #88 has days, see shared/timeline.ts).
 */

export interface Tokens {
  input: number
  output: number
  /** Written to the prompt cache. */
  cacheWrite: number
  /** Read from the prompt cache: usually most of the total. */
  cacheRead: number
}

/** Bucket (YYYY-MM-DDTHH, or YYYY-MM-DD) → tokens. The name is from when buckets were days. */
export type TokensByDay = Record<string, Tokens>

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead }
}

export function tokenSum(t: Tokens): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead
}

/** Tokens of the days [from, to] (YYYY-MM-DD, inclusive). */
export function tokensBetween(byDay: TokensByDay | undefined, from: string, to: string): Tokens {
  let t = NO_TOKENS
  for (const [b, v] of Object.entries(byDay ?? {})) if (b.slice(0, 10) >= from && b.slice(0, 10) <= to) t = addTokens(t, v)
  return t
}

/** Tokens in [from, to) (epoch ms); a bucket the range cuts through gives its share, rounded. */
export function tokensIn(byDay: TokensByDay | undefined, from: number, to: number, now: number): Tokens {
  const t = { ...NO_TOKENS }
  for (const [b, v] of Object.entries(byDay ?? {})) {
    const f = bucketShare(b, from, to, now)
    if (f === 0) continue
    t.input += v.input * f
    t.output += v.output * f
    t.cacheWrite += v.cacheWrite * f
    t.cacheRead += v.cacheRead * f
  }
  return { input: Math.round(t.input), output: Math.round(t.output), cacheWrite: Math.round(t.cacheWrite), cacheRead: Math.round(t.cacheRead) }
}

export function formatTokens(n: number | null): string {
  if (n === null) return '—'
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
  return `${(n / 1e9).toFixed(2)}B`
}

/** The breakdown, for a tooltip. */
export function tokenTitle(t: Tokens): string {
  return [
    `${tokenSum(t).toLocaleString()} tokens`,
    `input ${t.input.toLocaleString()}`,
    `output ${t.output.toLocaleString()}`,
    `cache write ${t.cacheWrite.toLocaleString()}`,
    `cache read ${t.cacheRead.toLocaleString()}`,
  ].join('\n')
}

/** One transcript file's running tally; small enough to save and pick up where it left off. */
export interface FileTally {
  offset: number
  /** An incomplete last line, carried to the next read. */
  rest: string
  byDay: TokensByDay
  /** Message ids counted lately: a message's repeated lines sit close together. */
  recent: string[]
  /** When the session was active (shared/hours.ts): lines within SPAN_GRAIN of each other share a span. */
  spans?: Span[]
}

/** [start, end] in epoch ms. */
export type Span = [number, number]

/** Lines this close together share a span; the hours estimate never uses a smaller idle gap. */
export const SPAN_GRAIN = 5 * 60_000

const RECENT = 64
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function newFileTally(): FileTally {
  return { offset: 0, rest: '', byDay: {}, recent: [], spans: [] }
}

/** A parsed transcript line's own time (epoch ms; NaN without one): the top-level key only. */
const ownTime = (d: Record<string, unknown>): number => (typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN)

/** A transcript line's own time; a "timestamp" nested in it (a tool result, a file snapshot) never counts. */
export function lineTime(line: string): number {
  try {
    return ownTime(JSON.parse(line))
  } catch {
    return NaN
  }
}

/** One moment of activity: it widens the last span when close to it, else opens one. */
export function addMoment(spans: Span[], at: number): void {
  const last = spans[spans.length - 1]
  if (last && at >= last[0] - SPAN_GRAIN && at <= last[1] + SPAN_GRAIN) {
    if (at < last[0]) last[0] = at
    if (at > last[1]) last[1] = at
  } else spans.push([at, at])
}

/** Count the usage in these transcript lines into the tally, and their times into its spans. */
export function tallyLines(t: FileTally, lines: string[]): void {
  const spans = (t.spans ??= [])
  for (const line of lines) {
    // Parsed once, for its time and its usage: a nested "timestamp" must not pass for the line's own.
    if (!line.includes('"timestamp"') && !line.includes('"usage"')) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    // Any line with a time is activity: a prompt, a reply, a tool run.
    const at = ownTime(d)
    if (Number.isFinite(at)) addMoment(spans, at)
    if (!line.includes('"usage"')) continue
    const m = d.message as Record<string, unknown> | undefined
    const u = m && typeof m === 'object' ? (m.usage as Record<string, unknown> | undefined) : undefined
    if (!u || typeof u !== 'object') continue
    const id = String(m!.id ?? d.requestId ?? d.uuid ?? '')
    if (id) {
      if (t.recent.includes(id)) continue
      t.recent.push(id)
      if (t.recent.length > RECENT) t.recent.splice(0, t.recent.length - RECENT)
    }
    const hour = hourOf(Number.isFinite(at) ? at : Date.now())
    t.byDay[hour] = addTokens(t.byDay[hour] ?? NO_TOKENS, {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
      cacheRead: n(u.cache_read_input_tokens),
    })
  }
}

export function mergeByDay(list: TokensByDay[]): TokensByDay {
  const out: TokensByDay = {}
  for (const b of list) for (const [d, v] of Object.entries(b)) out[d] = addTokens(out[d] ?? NO_TOKENS, v)
  return out
}

export function totalOf(byDay: TokensByDay | undefined): Tokens {
  return Object.values(byDay ?? {}).reduce(addTokens, NO_TOKENS)
}
