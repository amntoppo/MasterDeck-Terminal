import { dayOf } from './costs'

/**
 * Tokens a session used, summed from its transcripts: every assistant message carries a `usage`
 * block. Claude Code writes a message more than once as it streams (same message id, same usage),
 * so each id counts once. Tokens are kept per day (the message's own timestamp), like costs.
 */

export interface Tokens {
  input: number
  output: number
  /** Written to the prompt cache. */
  cacheWrite: number
  /** Read from the prompt cache: usually most of the total. */
  cacheRead: number
}

export type TokensByDay = Record<string, Tokens>

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead }
}

export function tokenSum(t: Tokens): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead
}

export function tokensBetween(byDay: TokensByDay | undefined, from: string, to: string): Tokens {
  let t = NO_TOKENS
  for (const [d, v] of Object.entries(byDay ?? {})) if (d >= from && d <= to) t = addTokens(t, v)
  return t
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
}

const RECENT = 64
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function newFileTally(): FileTally {
  return { offset: 0, rest: '', byDay: {}, recent: [] }
}

/** Count the usage in these transcript lines into the tally. */
export function tallyLines(t: FileTally, lines: string[]): void {
  for (const line of lines) {
    if (!line.includes('"usage"')) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const m = d.message as Record<string, unknown> | undefined
    const u = m && typeof m === 'object' ? (m.usage as Record<string, unknown> | undefined) : undefined
    if (!u || typeof u !== 'object') continue
    const id = String(m!.id ?? d.requestId ?? d.uuid ?? '')
    if (id) {
      if (t.recent.includes(id)) continue
      t.recent.push(id)
      if (t.recent.length > RECENT) t.recent.splice(0, t.recent.length - RECENT)
    }
    const at = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
    const day = dayOf(Number.isFinite(at) ? at : Date.now())
    t.byDay[day] = addTokens(t.byDay[day] ?? NO_TOKENS, {
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
