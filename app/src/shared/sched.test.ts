import { describe, expect, it } from 'vitest'
import {
  dueSlots,
  nextSlot,
  nextSlots,
  normalizeSchedule,
  parseSchedFile,
  planTick,
  runCost,
  runName,
  runProgress,
  runPrompt,
  runSession,
  schedView,
  slugOf,
  whenCron,
  whenText,
  withRun,
  zonedParts,
  SCHED_RUNS_KEPT,
  type Schedule,
  type SchedRun,
} from './sched'
import type { Session } from './types'

const H = 3_600_000
const M = 60_000
const utc = (s: string) => Date.parse(`${s}Z`)

const sched = (o: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  name: 'Morning triage',
  enabled: true,
  prompt: 'Triage new issues',
  workflow: null,
  cwd: '/tmp',
  account: null,
  model: null,
  mode: null,
  when: { kind: 'daily', time: '09:00' },
  tz: 'UTC',
  skipIfRunning: true,
  maxCostUsd: null,
  notify: { finish: true, failure: true },
  missed: 'once',
  createdAt: 0,
  updatedAt: 0,
  lastSlot: utc('2026-10-17T00:00:00'),
  ...o,
})

const run = (o: Partial<SchedRun> = {}): SchedRun => ({
  id: 'r1',
  scheduleId: 's1',
  scheduleName: 'Morning triage',
  slot: null,
  trigger: 'schedule',
  status: 'running',
  startedAt: 1_000_000,
  endedAt: null,
  sessionName: 'morning-triage-1017-0900',
  bgId: 'abcd1234',
  sessionId: null,
  seenWorking: false,
  seen: false,
  costUsd: 0,
  ...o,
})

const session = (o: Partial<Session> = {}): Session => ({
  key: 'abcd1234',
  sessionId: 'abcd1234-0000-0000-0000-000000000000',
  name: 'morning-triage-1017-0900',
  kind: 'background',
  bgId: 'abcd1234',
  pid: 1,
  cwd: '/tmp',
  state: 'working',
  rawState: 'running',
  startedAt: 1_000_000,
  issue: null,
  ...o,
})

describe('whenCron / whenText', () => {
  it('compiles each kind', () => {
    expect(whenCron({ kind: 'daily', time: '09:05' })).toBe('5 9 * * *')
    expect(whenCron({ kind: 'weekdays', time: '18:30' })).toBe('30 18 * * 1-5')
    expect(whenCron({ kind: 'weekly', days: [3, 1, 3], time: '07:00' })).toBe('0 7 * * 1,3')
    expect(whenCron({ kind: 'hours', every: 4, minute: 15 })).toBe('15 */4 * * *')
    expect(whenCron({ kind: 'hours', every: 1, minute: 0 })).toBe('0 * * * *')
    expect(whenCron({ kind: 'cron', expr: ' 0  2 * * 0 ' })).toBe('0 2 * * 0')
    expect(whenCron({ kind: 'cron', expr: 'every day' })).toBeNull()
    expect(whenCron({ kind: 'daily', time: '25:00' })).toBeNull()
  })
  it('says it in words', () => {
    expect(whenText({ kind: 'weekly', days: [5, 1], time: '07:00' })).toBe('Mon, Fri at 07:00')
    expect(whenText({ kind: 'hours', every: 6, minute: 5 })).toBe('Every 6 hours at :05')
  })
})

describe('nextSlot in a time zone', () => {
  it('finds the next minute in UTC', () => {
    expect(nextSlot('0 9 * * *', utc('2026-10-17T08:00:00'), 'UTC')).toBe(utc('2026-10-17T09:00:00'))
    expect(nextSlot('0 9 * * *', utc('2026-10-17T09:00:00'), 'UTC')).toBe(utc('2026-10-18T09:00:00'))
  })
  it('keeps the wall-clock time of another zone', () => {
    // 09:00 in Berlin is 07:00 UTC in summer time (until 25 October 2026), 08:00 UTC after.
    expect(nextSlot('0 9 * * *', utc('2026-10-17T00:00:00'), 'Europe/Berlin')).toBe(utc('2026-10-17T07:00:00'))
    expect(nextSlot('0 9 * * *', utc('2026-10-26T00:00:00'), 'Europe/Berlin')).toBe(utc('2026-10-26T08:00:00'))
    // Kolkata is +05:30.
    expect(nextSlot('0 9 * * *', utc('2026-10-17T00:00:00'), 'Asia/Kolkata')).toBe(utc('2026-10-17T03:30:00'))
  })
  it('weekdays skip the weekend (17 October 2026 is a Saturday)', () => {
    expect(zonedParts(utc('2026-10-17T12:00:00'), 'UTC').dow).toBe(6)
    expect(nextSlot('0 9 * * 1-5', utc('2026-10-17T12:00:00'), 'UTC')).toBe(utc('2026-10-19T09:00:00'))
  })
  it('every N hours from midnight', () => {
    expect(nextSlots('15 */6 * * *', utc('2026-10-17T00:20:00'), 'UTC', 3)).toEqual([
      utc('2026-10-17T06:15:00'),
      utc('2026-10-17T12:15:00'),
      utc('2026-10-17T18:15:00'),
    ])
  })
  it('a weekly midnight slot survives the spring DST change (New York, 8 March 2026)', () => {
    expect(nextSlots('0 0 * * 1', utc('2026-03-01T12:00:00'), 'America/New_York', 3)).toEqual([
      utc('2026-03-02T05:00:00'),
      utc('2026-03-09T04:00:00'),
      utc('2026-03-16T04:00:00'),
    ])
    expect(nextSlots('30 0 * * 1-5', utc('2026-03-27T12:00:00'), 'Europe/Berlin', 2)).toEqual([utc('2026-03-29T22:30:00'), utc('2026-03-30T22:30:00')])
  })
  it('a cron that never matches returns null quickly', () => {
    const t0 = Date.now()
    expect(nextSlot('0 0 31 2 *', utc('2026-10-17T00:00:00'), 'UTC')).toBeNull()
    expect(Date.now() - t0).toBeLessThan(250)
  })
  it('weekday 7 is Sunday, also in ranges', () => {
    expect(nextSlot('0 9 * * 6-7', utc('2026-10-17T10:00:00'), 'UTC')).toBe(utc('2026-10-18T09:00:00'))
  })
  it('null for a bad cron or zone', () => {
    expect(nextSlot('x', 0, 'UTC')).toBeNull()
    expect(nextSlot('0 9 * * *', 0, 'Mars/Base')).toBeNull()
  })
})

describe('dueSlots / planTick', () => {
  it('nothing before the slot', () => {
    expect(planTick(sched(), utc('2026-10-17T08:59:00'))).toEqual({ kind: 'none' })
  })
  it('runs a slot on time and within the grace', () => {
    expect(planTick(sched(), utc('2026-10-17T09:00:20'))).toEqual({ kind: 'run', slot: utc('2026-10-17T09:00:00'), trigger: 'schedule' })
    expect(planTick(sched(), utc('2026-10-17T09:04:00')).kind).toBe('run')
  })
  it('a slot already handled does not run again', () => {
    expect(planTick(sched({ lastSlot: utc('2026-10-17T09:00:00') }), utc('2026-10-17T09:01:00'))).toEqual({ kind: 'none' })
  })
  it('missed slots run once, never a burst', () => {
    const s = sched({ when: { kind: 'hours', every: 1, minute: 0 }, lastSlot: utc('2026-10-17T00:30:00') })
    const p = planTick(s, utc('2026-10-17T06:30:00'))
    expect(p).toMatchObject({ kind: 'run', trigger: 'missed', slot: utc('2026-10-17T06:00:00') })
    expect(p.kind === 'run' && p.reason).toMatch(/^6 runs were missed/)
    expect(dueSlots('0 * * * *', 'UTC', utc('2026-10-17T00:30:00'), utc('2026-10-17T06:30:00'))).toEqual({ latest: utc('2026-10-17T06:00:00'), count: 6 })
  })
  it('missed slots are skipped when the schedule says so', () => {
    const p = planTick(sched({ missed: 'skip' }), utc('2026-10-17T12:00:00'))
    expect(p).toMatchObject({ kind: 'skip', slot: utc('2026-10-17T09:00:00') })
  })
  it('a clock that jumped back does not strand a schedule', () => {
    expect(planTick(sched({ lastSlot: utc('2026-10-20T00:00:00') }), utc('2026-10-17T09:00:20'))).toMatchObject({ kind: 'run', slot: utc('2026-10-17T09:00:00') })
  })
  it('a paused schedule does nothing', () => {
    expect(planTick(sched({ enabled: false }), utc('2026-10-17T09:00:20'))).toEqual({ kind: 'none' })
  })
  it('a long sleep with a minute cron stays bounded', () => {
    const t0 = Date.now()
    const p = planTick(sched({ when: { kind: 'cron', expr: '* * * * *' }, lastSlot: utc('2026-01-01T00:00:00') }), utc('2026-10-17T12:00:30'))
    expect(p).toMatchObject({ kind: 'run', trigger: 'schedule', slot: utc('2026-10-17T12:00:00') })
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})

describe('runName / runPrompt / slugOf', () => {
  it('names a run after the schedule and its slot in the zone', () => {
    const s = { name: 'Morning triage!', tz: 'Asia/Kolkata' }
    expect(runName(s, utc('2026-10-17T03:30:00'), () => false)).toBe('morning-triage-1017-0900')
    const taken = new Set(['morning-triage-1017-0900', 'morning-triage-1017-0900-2'])
    expect(runName(s, utc('2026-10-17T03:30:00'), (n) => taken.has(n))).toBe('morning-triage-1017-0900-3')
  })
  it('slugs', () => {
    expect(slugOf('  ')).toBe('schedule')
    expect(slugOf('Nightly dependency updates for every repository we own')).toBe('nightly-dependency-updates-for-every')
  })
  it('a workflow run without a prompt says what to follow', () => {
    expect(runPrompt({ name: 'CI', prompt: '' }, 'CI doctor')).toBe('Scheduled run of "CI": follow the workflow "CI doctor".')
    expect(runPrompt({ name: 'CI', prompt: ' Fix CI ' }, 'CI doctor')).toBe('Fix CI')
  })
})

describe('runProgress', () => {
  const now = 1_000_000 + 60_000
  it('working marks it seen and working', () => {
    expect(runProgress(run(), session(), now)).toEqual({ seen: true, sessionId: session().sessionId, seenWorking: true })
  })
  it('idle after working is done', () => {
    expect(runProgress(run({ seen: true, seenWorking: true, sessionId: session().sessionId }), session({ state: 'idle' }), now)).toEqual({ status: 'done', endedAt: now })
  })
  it('idle before working waits a little, then failed (it never started)', () => {
    const r = run({ seen: true, sessionId: session().sessionId })
    expect(runProgress(r, session({ state: 'idle' }), now)).toBeNull()
    expect(runProgress(r, session({ state: 'idle' }), 1_000_000 + 4 * M)).toMatchObject({ status: 'failed', reason: 'it never started working' })
  })
  it('a cost counts as having worked (a run faster than a poll)', () => {
    expect(runProgress(run({ seen: true, costUsd: 0.02 }), session({ state: 'idle' }), now)).toMatchObject({ status: 'done' })
  })
  it('a run with no end after 12 hours stops counting as running', () => {
    const r = run({ seen: true, seenWorking: true })
    expect(runProgress(r, session({ state: 'needs-input' }), 1_000_000 + 13 * H)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/12 hours/) })
  })
  it('waiting on the user or on a monitor is still running', () => {
    const r = run({ seen: true, seenWorking: true, sessionId: session().sessionId })
    expect(runProgress(r, session({ state: 'needs-input' }), now)).toBeNull()
    expect(runProgress(r, session({ state: 'idle', waitingOn: 'monitor' }), now)).toBeNull()
    expect(runProgress(r, session({ state: 'idle', busyWith: 'an agent' }), now)).toBeNull()
  })
  it('ended before working fails', () => {
    expect(runProgress(run({ seen: true, sessionId: session().sessionId }), session({ state: 'done' }), now)).toMatchObject({ status: 'failed' })
  })
  it('never listed fails after the timeout; gone after being seen is done', () => {
    expect(runProgress(run(), null, now)).toBeNull()
    expect(runProgress(run(), null, 1_000_000 + 11 * M)).toMatchObject({ status: 'failed' })
    expect(runProgress(run({ seen: true, seenWorking: true }), null, now)).toMatchObject({ status: 'done' })
    expect(runProgress(run({ seen: true }), null, now)).toMatchObject({ status: 'failed' })
  })
  it('finished runs do not change', () => {
    expect(runProgress(run({ status: 'done' }), session(), now)).toBeNull()
  })
})

describe('runSession / runCost', () => {
  it('finds by bg id, else by name', () => {
    const a = session()
    const b = session({ key: 'ffff0000', bgId: 'ffff0000', name: 'other' })
    expect(runSession(run(), [b, a])).toBe(a)
    expect(runSession(run({ bgId: null }), [b, a])).toBe(a)
    expect(runSession(run({ bgId: null, sessionName: 'nope' }), [b, a])).toBeNull()
  })
  it('sums the cost book by key, or the live cost', () => {
    const r = run({ sessionId: 'sid-2' })
    const book = {
      'sid-1': { name: 'x', key: 'abcd1234', issue: null, days: { '2026-10-17T09': 0.5 } },
      'sid-2': { name: 'x', key: 'abcd1234', issue: null, days: { '2026-10-17T10': 0.25 } },
      'sid-3': { name: 'y', key: 'zzzz0000', issue: null, days: { '2026-10-17T10': 9 } },
    }
    expect(runCost(r, book, {})).toBe(0.75)
    expect(runCost(run({ sessionId: 'sid-9' }), book, { 'sid-9': { costUsd: 0.1 } })).toBe(0.85)
    expect(runCost(run({ bgId: null, sessionId: null, costUsd: 0.3 }), {}, {})).toBe(0.3)
  })
})

describe('withRun / schedView', () => {
  it('keeps the last runs per schedule', () => {
    let runs: SchedRun[] = [run({ id: 'other', scheduleId: 's2', status: 'done' })]
    for (let i = 0; i < SCHED_RUNS_KEPT + 5; i++) runs = withRun(runs, run({ id: `r${i}`, status: 'done' }))
    expect(runs.filter((r) => r.scheduleId === 's1')).toHaveLength(SCHED_RUNS_KEPT)
    expect(runs[0].id).toBe('other')
    expect(runs.at(-1)!.id).toBe(`r${SCHED_RUNS_KEPT + 4}`)
  })
  it('a view has the next run, running and the last run', () => {
    const v = schedView(sched(), [run({ status: 'done', id: 'a' }), run({ status: 'skipped', id: 'b' })], utc('2026-10-17T08:00:00'))
    expect(v.nextAt).toBe(utc('2026-10-17T09:00:00'))
    expect(v.running).toBe(false)
    expect(v.lastRun?.id).toBe('a')
    expect(schedView(sched({ enabled: false }), [], 0).nextAt).toBeNull()
  })
})

describe('normalizeSchedule', () => {
  const ok = () => true
  const base = { name: 'Nightly', prompt: 'Update dependencies', cwd: '/repo', when: { kind: 'daily', time: '02:00' }, tz: 'UTC' }
  it('fills defaults and starts counting from now', () => {
    const r = normalizeSchedule(base, null, 5000, ok, () => 'new')
    expect(r).toMatchObject({ ok: true, schedule: { id: 'new', enabled: true, skipIfRunning: true, missed: 'once', notify: { finish: true, failure: true }, lastSlot: 5000, workflow: null } })
  })
  it('refuses what cannot run', () => {
    const msg = (o: object) => {
      const r = normalizeSchedule({ ...base, ...o }, null, 0, ok, () => 'x')
      return r.ok ? null : r.message
    }
    expect(msg({ name: ' ' })).toMatch(/name/)
    expect(msg({ prompt: '', workflow: null })).toMatch(/prompt or pick a workflow/)
    expect(msg({ prompt: '--help' })).toMatch(/can't start/)
    expect(msg({ when: { kind: 'cron', expr: '1 2 3' } })).toMatch(/five fields/)
    expect(msg({ when: { kind: 'weekly', days: [], time: '09:00' } })).toMatch(/day/)
    expect(msg({ tz: 'Nowhere/Land' })).toMatch(/time zone/)
    expect(msg({ maxCostUsd: -1 })).toMatch(/cost/)
    expect(msg({ account: '-x' })).toMatch(/login/)
    expect(msg({ workflow: '../x' })).toMatch(/workflow/)
    expect(msg({ when: { kind: 'cron', expr: '0 0 31 2 *' } })).toMatch(/never runs/)
    expect(msg({ when: { kind: 'hours', every: 5, minute: 0 } })).toMatch(/divide a day/)
    expect(normalizeSchedule(base, null, 0, () => false, () => 'x')).toEqual({ ok: false, message: 'pick a folder that exists' })
  })
  it('a workflow alone is enough', () => {
    expect(normalizeSchedule({ ...base, prompt: '', workflow: 'md-ci-doctor' }, null, 0, ok, () => 'x').ok).toBe(true)
  })
  it('an edit keeps the id and the last slot unless when changes', () => {
    const prev = sched({ id: 'keep', lastSlot: 42, createdAt: 7, when: { kind: 'daily', time: '02:00' } })
    const same = normalizeSchedule({ ...base, prompt: 'other' }, prev, 9000, ok, () => 'x')
    expect(same).toMatchObject({ ok: true, schedule: { id: 'keep', createdAt: 7, lastSlot: 42, updatedAt: 9000 } })
    const moved = normalizeSchedule({ ...base, when: { kind: 'daily', time: '03:00' } }, prev, 9000, ok, () => 'x')
    expect(moved).toMatchObject({ ok: true, schedule: { lastSlot: 9000 } })
    const resumed = normalizeSchedule({ ...base, enabled: true }, { ...prev, enabled: false }, 9000, ok, () => 'x')
    expect(resumed).toMatchObject({ ok: true, schedule: { lastSlot: 9000, enabled: true } })
    // The editor sends no on/off: a pause made meanwhile stays.
    expect(normalizeSchedule(base, { ...prev, enabled: false }, 9000, ok, () => 'x')).toMatchObject({ ok: true, schedule: { enabled: false } })
  })
})

describe('parseSchedFile', () => {
  it('drops what cannot be read and runs of unknown schedules', () => {
    const f = parseSchedFile({ schedules: [sched(), { id: 2 }, { ...sched({ id: 'bad' }), when: { kind: 'cron', expr: 'x' } }], runs: [run(), run({ id: 'orphan', scheduleId: 'gone' }), 'x'] })
    expect(f.schedules.map((s) => s.id)).toEqual(['s1'])
    expect(f.runs.map((r) => r.id)).toEqual(['r1'])
    expect(parseSchedFile(null)).toEqual({ schedules: [], runs: [] })
  })
})
