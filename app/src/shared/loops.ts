/**
 * Workflow loops (#82) as MasterDeck reads them: the loop file the hooks write
 * (`<home>/workflows/loops/<sid>.json`, see `loopHook.ts`), what `AppState.loops` carries of it,
 * and the text the UI shows.
 */
import type { CompiledLoop } from './flow'

export type LoopState = 'open' | 'met' | 'limit' | 'stopped'
const STATES: LoopState[] = ['open', 'met', 'limit', 'stopped']

/** One round's check, as the loop hook records it. `exit` is null when the check did not run. */
export interface LoopCheck {
  n: number
  at: number
  ms: number
  passed: boolean
  said: boolean
  exit: number | null
  tail: string
  hash: string
}

export interface LoopEntry {
  id: string
  /** The compiled step that armed it. */
  step: string
  state: LoopState
  iteration: number
  startedAt: number
  history: LoopCheck[]
  reason: string | null
  lastCheck: LoopCheck | null
  /** Iterations Run 5 more added on top of the loop's limit. */
  extra?: number
  /** Rounds up to this one do not count toward the stall limit (set by Run 5 more). */
  stallFrom?: number
  /** When the user stopped it (the hook's own ends carry their time in `lastCheck`). */
  endedAt?: number
}

export interface LoopFile {
  loops: LoopEntry[]
}

/** What `AppState.loops` holds of a loop: small, and nothing in it ticks by itself. */
export interface LoopView {
  id: string
  name: string
  state: LoopState
  /** Rounds done. */
  iteration: number
  /** The iteration limit, with what Run 5 more added. */
  max: number
  startedAt: number
  /** The time limit in minutes (0: none). */
  minutes: number
  reason: string | null
  /** When it closed (null while open). */
  endedAt: number | null
  lastCheck: { ran: boolean; passed: boolean; said: boolean; tail: string; at: number } | null
}

/** A loop's every round and the end of its progress file (`workflow:loopHistory`). */
export type LoopHistory =
  | { ok: true; name: string; history: LoopCheck[]; progress: string }
  | { ok: false; message: string }

export const LOOP_ID = /^[a-z0-9-]{1,24}$/
export const validLoopId = (id: unknown): id is string => typeof id === 'string' && LOOP_ID.test(id)

/** At most this many loops per session in the state, and closed ones only this long. */
export const LOOPS_PER_SESSION = 3
export const LOOP_KEEP_MS = 24 * 3600_000
export const LOOP_TAIL_MAX = 1024
/** What Run 5 more adds. */
export const LOOP_MORE = 5

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function parseCheck(v: unknown): LoopCheck | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const n = num(o.n)
  const at = num(o.at)
  if (n === null || at === null) return null
  return {
    n,
    at,
    ms: num(o.ms) ?? 0,
    passed: o.passed === true,
    said: o.said === true,
    exit: num(o.exit),
    tail: str(o.tail) ?? '',
    hash: str(o.hash) ?? '',
  }
}

function parseEntry(v: unknown): LoopEntry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!validLoopId(o.id) || !STATES.includes(o.state as LoopState)) return null
  const startedAt = num(o.startedAt)
  if (startedAt === null) return null
  const e: LoopEntry = {
    id: o.id,
    step: str(o.step) ?? '',
    state: o.state as LoopState,
    iteration: Math.max(0, num(o.iteration) ?? 0),
    startedAt,
    history: Array.isArray(o.history) ? o.history.map(parseCheck).filter((c): c is LoopCheck => !!c) : [],
    reason: str(o.reason),
    lastCheck: parseCheck(o.lastCheck),
  }
  const extra = num(o.extra)
  if (extra !== null) e.extra = extra
  const stallFrom = num(o.stallFrom)
  if (stallFrom !== null) e.stallFrom = stallFrom
  const endedAt = num(o.endedAt)
  if (endedAt !== null) e.endedAt = endedAt
  return e
}

/** A loop file as read from disk: junk entries and unknown states are dropped; never throws. */
export function parseLoopFile(raw: unknown): LoopFile {
  const loops = raw && typeof raw === 'object' ? (raw as { loops?: unknown }).loops : null
  return { loops: Array.isArray(loops) ? loops.map(parseEntry).filter((e): e is LoopEntry => !!e) : [] }
}

/** When a closed loop closed: the user's stop, else its last round, else its start. */
export const loopEndedAt = (e: LoopEntry): number => e.endedAt ?? e.lastCheck?.at ?? e.startedAt

/**
 * A session's loops for the state: newest first, at most three, closed ones for a day, the check's
 * output cut to its last 1 KB. `defs` are the session's compiled loops (names and limits); a loop
 * its workflow no longer has keeps its id as its name.
 */
export function loopViews(file: LoopFile, defs: CompiledLoop[], now: number): LoopView[] {
  return file.loops
    .filter((e) => e.state === 'open' || now - loopEndedAt(e) < LOOP_KEEP_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, LOOPS_PER_SESSION)
    .map((e) => {
      const def = defs.find((d) => d.id === e.id)
      const c = e.lastCheck
      return {
        id: e.id,
        name: def?.name || e.id,
        state: e.state,
        iteration: e.iteration,
        max: (def?.limits.iterations ?? 0) + (e.extra ?? 0),
        startedAt: e.startedAt,
        minutes: def?.limits.minutes ?? 0,
        reason: e.reason,
        endedAt: e.state === 'open' ? null : loopEndedAt(e),
        lastCheck: c
          ? { ran: c.exit !== null, passed: c.passed, said: c.said, tail: c.tail.slice(-LOOP_TAIL_MAX), at: c.at }
          : null,
      }
    })
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The Details line: where an open loop is, or how it ended. */
export function loopLine(v: LoopView, now: number): string {
  const head = `↻ ${v.name}`
  if (v.state === 'met') return `${head} · done: ${v.reason ?? `criterion met after ${plural(v.iteration, 'iteration')}`}`
  if (v.state === 'limit') return `${head} · ${v.reason ?? 'stopped at a limit'}`
  if (v.state === 'stopped') return `${head} · ${v.reason ?? 'stopped'}`
  const min = Math.max(0, Math.floor((now - v.startedAt) / 60_000))
  const c = v.lastCheck
  const last = !c
    ? 'first round'
    : c.ran
      ? c.passed
        ? 'last check passed'
        : 'last check failed'
      : 'not done yet'
  return `${head} · iteration ${v.iteration}/${v.max} · ${min} min · ${last}`
}

/** The session row's badge: an open loop's count, or how it ended within the hour. */
export function loopBadge(v: LoopView, now: number): string | null {
  if (v.state === 'open') return `↻ ${v.iteration}/${v.max}`
  const recent = v.endedAt !== null && now - v.endedAt < 3600_000
  if (!recent) return null
  if (v.state === 'met') return '↻ ✓'
  if (v.state === 'limit') return '↻ !'
  return null
}

/**
 * The one text MasterDeck types into a session for a loop. The name is the user's own (the
 * workflow), but it is cleaned to the remote text rules all the same: no control characters, and
 * nothing that could read as a slash command or a shell escape.
 */
export function loopNudge(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/^[\s/!]+/, '').replace(/"/g, "'").trim().slice(0, 80)
  return `Continue the loop "${clean || 'loop'}".`
}
