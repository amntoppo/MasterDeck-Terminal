import { cronField } from './schedules'
import { sessionTotal, type CostBook } from './costs'
import type { Session } from './types'

/**
 * Schedules (#140): sessions MasterDeck starts on a timer, with a prompt and optionally a saved
 * workflow, in a folder, as an account, with a model. Not `shared/schedules.ts`: those are the
 * CronCreate jobs a session made itself. This file is the pure part (validation, slots in a time
 * zone, what a tick does, how a run is going); `main/sched.ts` keeps the file and starts sessions.
 */

export type SchedWhen =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'hours'; every: number; minute: number }
  | { kind: 'cron'; expr: string }

export interface Schedule {
  id: string
  name: string
  enabled: boolean
  /** The first message; may be empty when a workflow is picked (then `defaultPrompt`). */
  prompt: string
  /** A workflow template id; null: the default workflow. */
  workflow: string | null
  cwd: string
  /** GitHub login (two or more accounts); null: the folder's account, as New Claude session. */
  account: string | null
  model: string | null
  mode: string | null
  when: SchedWhen
  /** IANA time zone the times are in. */
  tz: string
  skipIfRunning: boolean
  maxCostUsd: number | null
  notify: { finish: boolean; failure: boolean }
  /** Slots missed while the Mac slept or MasterDeck was closed: one run when it is back, or none. */
  missed: 'once' | 'skip'
  createdAt: number
  updatedAt: number
  /** The last slot handled (run, skipped or missed); slots after it are due. */
  lastSlot: number
}

export type SchedRunStatus = 'running' | 'done' | 'failed' | 'skipped' | 'stopped'
export type SchedTrigger = 'schedule' | 'missed' | 'manual'

export interface SchedRun {
  id: string
  scheduleId: string
  scheduleName: string
  /** The planned time; null for Run now. */
  slot: number | null
  trigger: SchedTrigger
  status: SchedRunStatus
  reason?: string
  startedAt: number
  endedAt: number | null
  sessionName: string
  bgId: string | null
  sessionId: string | null
  /** The session has been seen working (so an idle one has finished, not not-yet-started). */
  seenWorking: boolean
  /** The session has been listed at least once. */
  seen: boolean
  costUsd: number
}

export interface SchedFile {
  schedules: Schedule[]
  runs: SchedRun[]
}

/** A schedule as the view gets it. */
export interface SchedView extends Schedule {
  cron: string | null
  whenText: string
  nextAt: number | null
  running: boolean
  lastRun: SchedRun | null
}

export interface SchedList {
  schedules: SchedView[]
  runs: SchedRun[]
  /** The Mac's time zone (the editor's default). */
  tz: string
}

/** What `sched:save` takes: a schedule without the fields MasterDeck keeps. */
export type SchedInput = Partial<Omit<Schedule, 'createdAt' | 'updatedAt' | 'lastSlot'>>

export const SCHED_TICK_MS = 30_000
/** A slot found this late still runs as itself; later, it was missed. */
export const SCHED_GRACE_MS = 5 * 60_000
/** Runs kept per schedule. */
export const SCHED_RUNS_KEPT = 50
export const SCHED_MAX = 100
/** A run whose session is never listed is failed after this. */
export const SCHED_START_TIMEOUT_MS = 10 * 60_000
/** A started session idle this long without having worked has finished (or never will). */
export const SCHED_IDLE_DONE_MS = 3 * 60_000
/** Cost keeps being read this long after a run ended (the status line lags). */
export const SCHED_COST_TAIL_MS = 10 * 60_000
/** Slots are looked for this far back at most (a long sleep with a minute cron stays cheap). */
const LOOKBACK_MS = 2 * 24 * 3_600_000
/** A cron with no slot this far ahead never runs. */
export const SCHED_HORIZON_MS = 5 * 366 * 24 * 3_600_000
/** A run with no end seen this long after its start is no longer counted as running. */
export const SCHED_RUN_MAX_MS = 12 * 3_600_000
/** Every N hours: N divides a day, so the runs stay evenly spaced across midnight. */
export const SCHED_EVERY = [1, 2, 3, 4, 6, 8, 12]

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MODEL_RE = /^[\w.[\]-]{1,80}$/
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const TEMPLATE_RE = /^[a-z0-9-]{1,48}$/
export const SCHED_MODES = ['plan', 'acceptEdits', 'auto', 'manual'] as const
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function validZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The cron a `when` stands for; null when it cannot be read. */
export function whenCron(w: SchedWhen): string | null {
  const hm = (t: string): [number, number] | null => {
    const m = TIME_RE.exec(t)
    return m ? [Number(m[1]), Number(m[2])] : null
  }
  switch (w.kind) {
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const t = hm(w.time)
      if (!t) return null
      const dow = w.kind === 'daily' ? '*' : w.kind === 'weekdays' ? '1-5' : [...new Set(w.days)].sort().join(',')
      return dow ? `${t[1]} ${t[0]} * * ${dow}` : null
    }
    case 'hours':
      return `${w.minute} ${w.every === 1 ? '*' : `*/${w.every}`} * * *`
    case 'cron':
      return parseCron(w.expr) ? w.expr.trim().replace(/\s+/g, ' ') : null
  }
}

/** A `when` in words. */
export function whenText(w: SchedWhen): string {
  switch (w.kind) {
    case 'daily':
      return `Every day at ${w.time}`
    case 'weekdays':
      return `Weekdays at ${w.time}`
    case 'weekly':
      return `${[...new Set(w.days)].sort().map((d) => DAYS[d]).join(', ')} at ${w.time}`
    case 'hours':
      return w.every === 1 ? `Every hour at :${String(w.minute).padStart(2, '0')}` : `Every ${w.every} hours at :${String(w.minute).padStart(2, '0')}`
    case 'cron':
      return `cron ${w.expr.trim()}`
  }
}

interface Cron {
  min: Set<number>
  hour: Set<number>
  dom: Set<number>
  mon: Set<number>
  dow: Set<number>
  anyDom: boolean
  anyDow: boolean
}

export function parseCron(expr: string): Cron | null {
  const f = String(expr ?? '').trim().split(/\s+/)
  if (f.length !== 5) return null
  const min = cronField(f[0], 0, 59)
  const hour = cronField(f[1], 0, 23)
  const dom = cronField(f[2], 1, 31)
  const mon = cronField(f[3], 1, 12)
  // 0 and 7 are both Sunday; read 0-7 so ranges like 5-7 work, then fold 7 into 0.
  const dow = cronField(f[4], 0, 7)
  if (!min || !hour || !dom || !mon || !dow) return null
  if (dow.delete(7)) dow.add(0)
  return { min, hour, dom, mon, dow, anyDom: f[2] === '*', anyDow: f[4] === '*' }
}

const formats = new Map<string, Intl.DateTimeFormat>()
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock parts of `t` in `tz`. */
export function zonedParts(t: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    formats.set(tz, f)
  }
  const o: Record<string, string> = {}
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value
  return { year: Number(o.year), month: Number(o.month), day: Number(o.day), hour: Number(o.hour) % 24, minute: Number(o.minute), dow: WD[o.weekday] ?? 0 }
}

type Parts = ReturnType<typeof zonedParts>

/** A wall-clock minute as one comparable number (year, month, day, hour, minute). */
const wallKey = (p: Parts): number => (((p.year * 13 + p.month) * 32 + p.day) * 24 + p.hour) * 60 + p.minute

/**
 * The first minute after `from` that `cron` matches in wall-clock time of `tz`; null when the cron
 * is unreadable or matches nothing within SCHED_HORIZON_MS (a cron like Feb 31 never does). Whole
 * days and hours that cannot match are skipped; the jump to the next midnight is corrected when a
 * DST change made the day shorter or longer than 24 hours.
 *
 * Wall-clock minutes, not instants, are what a schedule names, so across DST changes (as cron
 * does): when the clock goes back, a wall-clock minute already passed (at or before `from`'s, or
 * `wallAfter`'s: the last slot handled) is not matched again in the repeated hour; when it jumps
 * forward, slots in the skipped hour run at the first minute after the gap, once.
 */
export function nextSlot(cron: string, from: number, tz: string, wallAfter: number = from): number | null {
  const c = parseCron(cron)
  if (!c || !validZone(tz)) return null
  let t = Math.floor(from / 60_000) * 60_000 + 60_000
  const end = from + SCHED_HORIZON_MS
  const floor = Math.max(wallKey(zonedParts(from, tz)), wallKey(zonedParts(wallAfter, tz)))
  while (t <= end) {
    const p = zonedParts(t, tz)
    const dayOk = c.anyDom && c.anyDow ? true : c.anyDom ? c.dow.has(p.dow) : c.anyDow ? c.dom.has(p.day) : c.dom.has(p.day) || c.dow.has(p.dow)
    if (c.mon.has(p.month) && dayOk && inGap(c, t, p, tz, floor)) return t
    if (!c.mon.has(p.month) || !dayOk) {
      t += ((24 - p.hour) * 60 - p.minute) * 60_000
      // A 23-hour day lands at 01:00: step back to the day's midnight (if that day has one).
      const q = zonedParts(t, tz)
      if (q.hour > 0 && q.hour < 12) {
        const back = t - q.hour * 3_600_000
        if (zonedParts(back, tz).day === q.day) t = back
      }
      continue
    }
    if (!c.hour.has(p.hour)) {
      t += (60 - p.minute) * 60_000
      continue
    }
    // The repeated hour after the clock went back: this wall-clock minute was matched already.
    if (!c.min.has(p.minute) || wallKey(p) <= floor) {
      t += 60_000
      continue
    }
    return t
  }
  return null
}

/** Whether the clock jumped forward just before `t` (a DST gap) over a minute the cron matches. */
function inGap(c: Cron, t: number, p: Parts, tz: string, floor: number): boolean {
  const q = zonedParts(t - 60_000, tz)
  if (q.year !== p.year || q.month !== p.month || q.day !== p.day) return false
  const a = q.hour * 60 + q.minute
  const b = p.hour * 60 + p.minute
  if (b - a <= 1) return false
  for (let m = a + 1; m < b; m++)
    if (c.hour.has(Math.floor(m / 60)) && c.min.has(m % 60) && wallKey({ ...p, hour: Math.floor(m / 60), minute: m % 60 }) > floor) return true
  return false
}

/** The next `n` slots after `from` (the editor's preview). */
export function nextSlots(cron: string, from: number, tz: string, n: number): number[] {
  const out: number[] = []
  let t = from
  for (let i = 0; i < n; i++) {
    const s = nextSlot(cron, t, tz)
    if (s === null) break
    out.push(s)
    t = s
  }
  return out
}

/** The slots after `after` up to `now`: the latest, and how many (at least; the look back is bounded). */
export function dueSlots(cron: string, tz: string, after: number, now: number): { latest: number | null; count: number } {
  let t = Math.max(after, now - LOOKBACK_MS)
  let latest: number | null = null
  let count = 0
  for (let i = 0; i < 10_000; i++) {
    const s = nextSlot(cron, t, tz)
    if (s === null || s > now) break
    latest = s
    count++
    t = s
  }
  return { latest, count }
}

export type TickPlan =
  | { kind: 'none' }
  | { kind: 'run'; slot: number; trigger: 'schedule' | 'missed'; reason?: string }
  | { kind: 'skip'; slot: number; reason: string }

/**
 * What a tick does for one schedule (before overlap and the one-missed-run-per-tick rule, which
 * the runner applies). A due slot runs; one found late (the Mac slept, MasterDeck was closed)
 * runs once or is skipped as the schedule says. Either way `lastSlot` moves to the latest slot,
 * so a schedule acts at most once per tick and never on the same slot twice.
 */
export function planTick(s: Schedule, now: number): TickPlan {
  if (!s.enabled) return { kind: 'none' }
  const cron = whenCron(s.when)
  if (!cron) return { kind: 'none' }
  // A clock that jumped back leaves lastSlot ahead of now: count from now, not from the future.
  const { latest, count } = dueSlots(cron, s.tz, s.lastSlot > now ? now - SCHED_GRACE_MS : s.lastSlot, now)
  if (latest === null) return { kind: 'none' }
  if (now - latest <= SCHED_GRACE_MS) return { kind: 'run', slot: latest, trigger: 'schedule' }
  const n = count === 1 ? 'a run was' : `${count} runs were`
  if (s.missed === 'skip') return { kind: 'skip', slot: latest, reason: `${n} missed while the Mac slept or MasterDeck was closed` }
  return { kind: 'run', slot: latest, trigger: 'missed', reason: `${n} missed while the Mac slept or MasterDeck was closed; this is the one catch-up run` }
}

/** Lower-case words joined by dashes, for a session name. */
export function slugOf(text: string, limit = 40): string {
  let s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length > limit) {
    s = s.slice(0, limit)
    if (s.includes('-')) s = s.slice(0, s.lastIndexOf('-'))
  }
  return s.replace(/-+$/, '') || 'schedule'
}

/** A run's session name: `<schedule>-<MMDD-HHmm>` in the schedule's zone, `-2` … when taken. */
export function runName(s: Pick<Schedule, 'name' | 'tz'>, at: number, taken: (name: string) => boolean): string {
  const p = zonedParts(at, validZone(s.tz) ? s.tz : 'UTC')
  const two = (n: number) => String(n).padStart(2, '0')
  const base = `${slugOf(s.name)}-${two(p.month)}${two(p.day)}-${two(p.hour)}${two(p.minute)}`
  if (!taken(base)) return base
  for (let i = 2; i < 100; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${Date.now() % 10_000}`
}

/** The first message of a run. */
export function runPrompt(s: Pick<Schedule, 'name' | 'prompt'>, workflowName: string | null): string {
  const p = s.prompt.trim()
  if (p) return p
  return `Scheduled run of "${s.name}": follow the workflow "${workflowName ?? 'default'}".`
}

/**
 * How a run is going, from its session (null: not listed now). Returns the fields that change, or
 * null when nothing does. A session waiting on the user is still running: it has not finished.
 */
export function runProgress(r: SchedRun, s: Session | null, now: number): Partial<SchedRun> | null {
  if (r.status !== 'running') return null
  const worked = r.seenWorking || r.costUsd > 0
  if (now - r.startedAt > SCHED_RUN_MAX_MS)
    return { status: 'failed', endedAt: now, reason: 'no end seen after 12 hours (waiting on you, or on something it set up); no longer counted as running' }
  if (!s) {
    if (r.seen) return worked ? { status: 'done', endedAt: now, reason: 'the session is no longer listed' } : { status: 'failed', endedAt: now, reason: 'the session ended before it did any work' }
    if (now - r.startedAt > SCHED_START_TIMEOUT_MS) return { status: 'failed', endedAt: now, reason: 'the session never showed up in the session list' }
    return null
  }
  const ids: Partial<SchedRun> = {}
  if (!r.seen) ids.seen = true
  if (s.sessionId && s.sessionId !== r.sessionId) ids.sessionId = s.sessionId
  if (!r.bgId && s.bgId) ids.bgId = s.bgId
  const working = s.state === 'working' || s.state === 'needs-input' || !!s.busyWith
  if (working) {
    if (!r.seenWorking) ids.seenWorking = true
    return Object.keys(ids).length ? ids : null
  }
  if (s.state === 'done' || s.state === 'suspended')
    return worked ? { ...ids, status: 'done', endedAt: now } : { ...ids, status: 'failed', endedAt: now, reason: 'the session ended before it did any work' }
  // idle: finished once it worked (seen working, or it spent something) and waits on nothing it set up.
  if (!s.waitingOn && worked) return { ...ids, status: 'done', endedAt: now }
  // Idle a while without ever working: it never started (an API error, a bad model name).
  if (!s.waitingOn && now - r.startedAt > SCHED_IDLE_DONE_MS) return { ...ids, status: 'failed', endedAt: now, reason: 'it never started working' }
  return Object.keys(ids).length ? ids : null
}

/** A run's session in the list: by background id, else by name (started after the run). */
export function runSession(r: SchedRun, sessions: Session[]): Session | null {
  if (r.bgId) {
    const s = sessions.find((x) => x.key === r.bgId || x.bgId === r.bgId)
    if (s) return s
  }
  return sessions.find((x) => x.name === r.sessionName && x.state !== 'done' && x.startedAt >= r.startedAt - 60_000) ?? null
}

/** A run's cost: its sessions in the cost book (every id after resumes), or the live status line when higher. */
export function runCost(r: SchedRun, book: CostBook, live: Record<string, { costUsd: number | null }>): number {
  let sum = 0
  let current = false
  for (const [id, rec] of Object.entries(book)) {
    if ((r.bgId && rec.key === r.bgId) || (r.sessionId && id === r.sessionId)) {
      sum += sessionTotal(rec)
      if (id === r.sessionId) current = true
    }
  }
  const now = r.sessionId ? live[r.sessionId]?.costUsd : null
  if (!current && typeof now === 'number' && now > 0) sum += now
  return Math.round(Math.max(sum, r.costUsd) * 10_000) / 10_000
}

/** Add a run, keeping the last SCHED_RUNS_KEPT per schedule. */
export function withRun(runs: SchedRun[], r: SchedRun): SchedRun[] {
  const all = [...runs, r]
  const mine = all.filter((x) => x.scheduleId === r.scheduleId)
  if (mine.length <= SCHED_RUNS_KEPT) return all
  const drop = new Set(mine.slice(0, mine.length - SCHED_RUNS_KEPT).filter((x) => x.status !== 'running').map((x) => x.id))
  return all.filter((x) => !drop.has(x.id))
}

export function schedView(s: Schedule, runs: SchedRun[], now: number): SchedView {
  const cron = whenCron(s.when)
  const mine = runs.filter((r) => r.scheduleId === s.id).sort((a, b) => a.startedAt - b.startedAt)
  return {
    ...s,
    cron,
    whenText: whenText(s.when),
    nextAt: s.enabled && cron ? nextSlot(cron, Math.max(now, s.lastSlot), s.tz, s.lastSlot) : null,
    running: mine.some((r) => r.status === 'running'),
    lastRun: mine.filter((r) => r.status !== 'skipped').at(-1) ?? mine.at(-1) ?? null,
  }
}

type Norm = { ok: true; schedule: Schedule } | { ok: false; message: string }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function normWhen(raw: unknown): SchedWhen | string {
  const w = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const time = str(w.time, 5)
  switch (w.kind) {
    case 'daily':
    case 'weekdays':
      return TIME_RE.test(time) ? { kind: w.kind, time } : 'pick a time (HH:MM)'
    case 'weekly': {
      const days = Array.isArray(w.days) ? [...new Set(w.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
      if (!days.length) return 'pick at least one day'
      return TIME_RE.test(time) ? { kind: 'weekly', days, time } : 'pick a time (HH:MM)'
    }
    case 'hours': {
      const every = Number(w.every)
      const minute = Number(w.minute ?? 0)
      if (!SCHED_EVERY.includes(every)) return `every ${SCHED_EVERY.join(', ')} hours (they divide a day)`
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return 'the minute is 0 to 59'
      return { kind: 'hours', every, minute }
    }
    case 'cron': {
      const expr = str(w.expr, 120)
      return parseCron(expr) ? { kind: 'cron', expr } : 'a cron has five fields: minute hour day month weekday'
    }
    default:
      return 'pick when it runs'
  }
}

/**
 * A schedule from what a window or a web tab sent: checked field by field, with defaults. `prev`:
 * the schedule it edits (its id, dates and last slot are kept; a change of when, or turning it on,
 * starts counting from now so nothing in the past is "missed"). `dirOk`: the folder exists.
 */
export function normalizeSchedule(raw: unknown, prev: Schedule | null, now: number, dirOk: (p: string) => boolean, newId: () => string): Norm {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = str(o.name, 80)
  if (!name) return { ok: false, message: 'give it a name' }
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim().slice(0, 20_000) : ''
  if (prompt.startsWith('-')) return { ok: false, message: "the prompt can't start with -" }
  const workflow = typeof o.workflow === 'string' && o.workflow && o.workflow !== 'default' ? o.workflow : null
  if (workflow && !TEMPLATE_RE.test(workflow)) return { ok: false, message: 'unknown workflow' }
  if (!prompt && !workflow) return { ok: false, message: 'write a prompt or pick a workflow' }
  const cwd = typeof o.cwd === 'string' ? o.cwd : ''
  if (!cwd || !dirOk(cwd)) return { ok: false, message: 'pick a folder that exists' }
  const account = typeof o.account === 'string' && o.account ? o.account : null
  if (account && !LOGIN_RE.test(account)) return { ok: false, message: 'not a GitHub login' }
  const model = typeof o.model === 'string' && o.model ? o.model : null
  if (model && !MODEL_RE.test(model)) return { ok: false, message: 'not a model name' }
  const mode = typeof o.mode === 'string' && (SCHED_MODES as readonly string[]).includes(o.mode) ? o.mode : null
  const when = normWhen(o.when)
  if (typeof when === 'string') return { ok: false, message: when }
  const tz = o.tz === undefined || o.tz === '' ? localZone() : o.tz
  if (!validZone(tz)) return { ok: false, message: 'unknown time zone' }
  if (nextSlot(whenCron(when) ?? '', now, tz) === null) return { ok: false, message: 'it never runs: no day matches that cron' }
  const cap = o.maxCostUsd === null || o.maxCostUsd === undefined || o.maxCostUsd === '' ? null : Number(o.maxCostUsd)
  if (cap !== null && !(Number.isFinite(cap) && cap > 0 && cap <= 10_000)) return { ok: false, message: 'the cost limit is a dollar amount above 0' }
  const n = (o.notify && typeof o.notify === 'object' ? o.notify : {}) as Record<string, unknown>
  // Not sent (the editor of an existing schedule): as it is now, so an edit never undoes a pause made meanwhile.
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : (prev?.enabled ?? true)
  const restart = !prev || !prev.enabled || whenCron(prev.when) !== whenCron(when) || prev.tz !== tz
  return {
    ok: true,
    schedule: {
      id: prev?.id ?? newId(),
      name,
      enabled,
      prompt,
      workflow,
      cwd,
      account,
      model,
      mode,
      when,
      tz,
      skipIfRunning: o.skipIfRunning !== false,
      maxCostUsd: cap,
      notify: { finish: n.finish !== false, failure: n.failure !== false },
      missed: o.missed === 'skip' ? 'skip' : 'once',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      lastSlot: restart ? now : (prev?.lastSlot ?? now),
    },
  }
}

/** Read the file's contents back: what cannot be read is dropped, never guessed. */
export function parseSchedFile(raw: unknown): SchedFile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const schedules: Schedule[] = []
  for (const s of Array.isArray(o.schedules) ? o.schedules : []) {
    if (!s || typeof s !== 'object') continue
    const x = s as Schedule
    if (typeof x.id !== 'string' || typeof x.name !== 'string' || typeof x.cwd !== 'string' || !x.when || typeof x.tz !== 'string') continue
    if (!whenCron(x.when)) continue
    schedules.push({ ...x, lastSlot: typeof x.lastSlot === 'number' ? x.lastSlot : Date.now(), notify: x.notify ?? { finish: true, failure: true } })
  }
  const ids = new Set(schedules.map((s) => s.id))
  const runs = (Array.isArray(o.runs) ? o.runs : []).filter(
    (r): r is SchedRun => !!r && typeof r === 'object' && typeof (r as SchedRun).id === 'string' && ids.has((r as SchedRun).scheduleId) && typeof (r as SchedRun).startedAt === 'number',
  )
  return { schedules: schedules.slice(0, SCHED_MAX), runs }
}
