import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Scheduler, type SchedDeps, type SchedStart, type SchedState } from './sched'
import type { Session } from '@shared/types'
import type { SchedRun } from '@shared/sched'

const utc = (s: string) => Date.parse(`${s}Z`)
const M = 60_000

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-sched-'))
  file = join(dir, 'schedules.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const session = (o: Partial<Session> = {}): Session => ({
  key: 'abcd1234',
  sessionId: 'abcd1234-0000',
  name: 'x',
  kind: 'background',
  bgId: 'abcd1234',
  pid: 1,
  cwd: '/tmp',
  state: 'working',
  rawState: 'running',
  startedAt: 0,
  issue: null,
  ...o,
})

function harness(o: Partial<SchedDeps> = {}) {
  const h = {
    now: utc('2026-10-17T08:00:00'),
    state: { sessions: [], costBook: {}, allStats: {} } as SchedState | null,
    starts: [] as SchedStart[],
    stops: [] as string[],
    notes: [] as { title: string; body: string; sessionKey: string | null }[],
    startResult: null as null | { ok: false; message: string },
    changes: 0,
    ran: [] as SchedRun[],
  }
  let n = 0
  const d: SchedDeps = {
    now: () => h.now,
    state: () => h.state,
    start: async (r) => {
      h.starts.push(r)
      if (h.startResult) return h.startResult
      n++
      return { ok: true, bgId: `bg${String(n).padStart(6, '0')}` }
    },
    stop: async (bg) => {
      h.stops.push(bg)
      return { ok: true, message: 'stopped' }
    },
    notify: (x) => h.notes.push(x),
    templateName: (id) => (id === 'md-ci-doctor' ? 'CI doctor' : null),
    dirOk: () => true,
    onChange: () => h.changes++,
    onRun: (r) => h.ran.push(r),
    ...o,
  }
  return { h, s: () => new Scheduler(file, d) }
}

const input = (o: object = {}) => ({ name: 'Morning triage', prompt: 'Triage new issues', cwd: dir, when: { kind: 'daily', time: '09:00' }, tz: 'UTC', ...o })

describe('Scheduler', () => {
  it('saves, lists and keeps schedules across restarts', async () => {
    const { h, s } = harness()
    const a = s()
    const r = await a.save(input())
    expect(r.ok).toBe(true)
    const l = s().list()
    expect(l.schedules).toHaveLength(1)
    expect(l.schedules[0]).toMatchObject({ name: 'Morning triage', nextAt: utc('2026-10-17T09:00:00'), whenText: 'Every day at 09:00', running: false })
    expect(h.changes).toBe(1)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('starts a due slot once, with the run name, workflow and account', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input({ workflow: 'md-ci-doctor', prompt: '', account: 'octo', model: 'sonnet', mode: 'plan' }))
    h.now = utc('2026-10-17T09:00:10')
    await a.tick()
    await a.tick()
    expect(h.starts).toEqual([{ name: 'morning-triage-1017-0900', cwd: dir, prompt: 'Scheduled run of "Morning triage": follow the workflow "CI doctor".', workflow: 'md-ci-doctor', account: 'octo', model: 'sonnet', mode: 'plan' }])
    const runs = s().list().runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'running', trigger: 'schedule', bgId: 'bg000001', slot: utc('2026-10-17T09:00:00') })
    expect(a.tags()).toEqual({ bg000001: { scheduleId: runs[0].scheduleId, name: 'Morning triage' } })
  })

  it('waits for the session list', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input())
    h.state = null
    h.now = utc('2026-10-17T09:00:10')
    await a.tick()
    expect(h.starts).toHaveLength(0)
    expect((await a.runNow(a.list().schedules[0].id)).ok).toBe(false)
  })

  it('follows a run to done, with its cost, and notifies', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input())
    h.now = utc('2026-10-17T09:00:10')
    await a.tick()
    const sess = session({ key: 'bg000001', bgId: 'bg000001', sessionId: 'sid-1', name: 'morning-triage-1017-0900', startedAt: h.now })
    h.state = { sessions: [sess], costBook: {}, allStats: { 'sid-1': { costUsd: 0.4 } } }
    h.now += M
    await a.tick()
    expect(a.list().runs[0]).toMatchObject({ status: 'running', seenWorking: true, costUsd: 0.4 })
    h.state = { ...h.state, sessions: [{ ...sess, state: 'idle' }] }
    h.now += 11 * M
    await a.tick()
    expect(a.list().runs[0]).toMatchObject({ status: 'done', endedAt: h.now })
    expect(h.notes).toEqual([{ title: 'Morning triage: finished', body: 'morning-triage-1017-0900 · $0.40 · 12 min', sessionKey: 'bg000001' }])
  })

  it('skips an overlapping slot when asked, and starts another when not', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input({ when: { kind: 'hours', every: 1, minute: 0 } }))
    h.now = utc('2026-10-17T09:00:10')
    await a.tick()
    h.state = { sessions: [session({ key: 'bg000001', bgId: 'bg000001', startedAt: h.now })], costBook: {}, allStats: {} }
    h.now = utc('2026-10-17T10:00:10')
    await a.tick()
    expect(h.starts).toHaveLength(1)
    expect(a.list().runs[0]).toMatchObject({ status: 'skipped', reason: 'the previous run is still going' })
    expect(await a.runNow(a.list().schedules[0].id)).toEqual({ ok: false, message: 'the previous run is still going' })
    // Told once per stretch of skips, pointing at the run still going.
    h.now = utc('2026-10-17T11:00:10')
    await a.tick()
    expect(h.notes.filter((n) => n.title === 'Morning triage: skipped')).toEqual([{ title: 'Morning triage: skipped', body: 'the previous run is still going', sessionKey: 'bg000001' }])
    await a.save({ ...input({ when: { kind: 'hours', every: 1, minute: 0 }, skipIfRunning: false }), id: a.list().schedules[0].id })
    expect((await a.runNow(a.list().schedules[0].id)).ok).toBe(true)
    expect(h.starts).toHaveLength(2)
  })

  it('runs missed slots once after a restart, one schedule per tick', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input({ name: 'A' }))
    await a.save(input({ name: 'B' }))
    await a.save(input({ name: 'C', missed: 'skip' }))
    // MasterDeck was closed from 08:00 until 12:00 the next day.
    h.now = utc('2026-10-18T12:00:00')
    const b = s()
    await b.tick()
    expect(h.starts.map((x) => x.name)).toEqual(['a-1018-0900'])
    let runs = b.list().runs
    expect(runs.find((r) => r.scheduleName === 'A')).toMatchObject({ trigger: 'missed', reason: expect.stringMatching(/^2 runs were missed/) })
    expect(runs.find((r) => r.scheduleName === 'C')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/^2 runs were missed/) })
    h.now += 30_000
    await b.tick()
    expect(h.starts.map((x) => x.name)).toEqual(['a-1018-0900', 'b-1018-0900'])
    await b.tick()
    expect(h.starts).toHaveLength(2)
    runs = s().list().runs
    expect(runs.filter((r) => r.scheduleName === 'C')).toHaveLength(1)
  })

  it('a start that fails is a failed run, notified', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input())
    h.startResult = { ok: false, message: 'Workspace not trusted' }
    const r = await a.runNow(a.list().schedules[0].id)
    expect(r).toEqual({ ok: false, message: 'Workspace not trusted' })
    expect(a.list().runs[0]).toMatchObject({ status: 'failed', trigger: 'manual' })
    expect(h.notes[0]).toMatchObject({ title: 'Morning triage: failed', body: 'Workspace not trusted' })
  })

  it('onRun: once per run, when it ends (done, failed, skipped, stopped)', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input({ when: { kind: 'hours', every: 1, minute: 0 } }))
    h.now = utc('2026-10-17T09:00:10')
    await a.tick()
    expect(h.ran).toEqual([])
    const sess = session({ key: 'bg000001', bgId: 'bg000001', sessionId: 'sid-1', startedAt: h.now })
    h.state = { sessions: [sess], costBook: {}, allStats: {} }
    h.now = utc('2026-10-17T10:00:10')
    await a.tick()
    expect(h.ran.map((r) => r.status)).toEqual(['skipped'])
    h.state = { ...h.state, sessions: [{ ...sess, state: 'idle' }] }
    h.now += 11 * M
    await a.tick()
    await a.tick()
    expect(h.ran.map((r) => r.status)).toEqual(['skipped', 'done'])
    h.startResult = { ok: false, message: 'Workspace not trusted' }
    await a.runNow(a.list().schedules[0].id)
    expect(h.ran.map((r) => r.status)).toEqual(['skipped', 'done', 'failed'])
    expect(h.ran[2]).toMatchObject({ scheduleName: 'Morning triage', reason: 'Workspace not trusted' })
  })

  it('a throwing onRun breaks nothing', async () => {
    const { h, s } = harness({
      onRun: () => {
        throw new Error('boom')
      },
    })
    const a = s()
    await a.save(input())
    h.startResult = { ok: false, message: 'nope' }
    expect(await a.runNow(a.list().schedules[0].id)).toEqual({ ok: false, message: 'nope' })
    expect(s().list().runs[0]).toMatchObject({ status: 'failed' })
  })

  it('a missing workflow fails without starting', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input({ workflow: 'gone' }))
    const r = await a.runNow(a.list().schedules[0].id)
    expect(r.ok).toBe(false)
    expect(h.starts).toHaveLength(0)
  })

  it('stops a run over its cost limit', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input({ maxCostUsd: 1, notify: { finish: false, failure: true } }))
    await a.runNow(a.list().schedules[0].id)
    const sess = session({ key: 'bg000001', bgId: 'bg000001', sessionId: 'sid-1', startedAt: h.now })
    h.state = { sessions: [sess], costBook: {}, allStats: { 'sid-1': { costUsd: 1.5 } } }
    await a.tick()
    expect(h.stops).toEqual(['bg000001'])
    expect(a.list().runs[0]).toMatchObject({ status: 'stopped', costUsd: 1.5, reason: expect.stringMatching(/cost limit \(\$1\.00\)/) })
    expect(h.notes[0].title).toBe('Morning triage: stopped')
    expect(h.ran.map((r) => r.status)).toEqual(['stopped'])
  })

  it('a failed stop keeps the run running and tries again', async () => {
    let fail = true
    const stops: string[] = []
    const { h, s } = harness({ stop: async (bg) => (stops.push(bg), fail ? { ok: false, message: 'timed out' } : { ok: true, message: 'stopped' }) })
    const a = s()
    await a.save(input({ maxCostUsd: 1 }))
    await a.runNow(a.list().schedules[0].id)
    h.state = { sessions: [session({ key: 'bg000001', bgId: 'bg000001', sessionId: 'sid-1', startedAt: h.now })], costBook: {}, allStats: { 'sid-1': { costUsd: 1.5 } } }
    await a.tick()
    expect(a.list().runs[0]).toMatchObject({ status: 'running', reason: expect.stringMatching(/trying again: timed out/) })
    fail = false
    await a.tick()
    expect(stops).toEqual(['bg000001', 'bg000001'])
    expect(a.list().runs[0].status).toBe('stopped')
  })

  it('pause and resume: nothing missed while paused', async () => {
    const { h, s } = harness()
    const a = s()
    await a.save(input())
    const id = a.list().schedules[0].id
    await a.enable(id, false)
    expect(a.list().schedules[0].nextAt).toBeNull()
    h.now = utc('2026-10-17T10:00:00')
    await a.tick()
    await a.enable(id, true)
    await a.tick()
    expect(h.starts).toHaveLength(0)
    expect(a.list().schedules[0].nextAt).toBe(utc('2026-10-18T09:00:00'))
  })

  it('delete removes the schedule and its runs', async () => {
    const { s } = harness()
    const a = s()
    await a.save(input())
    const id = a.list().schedules[0].id
    await a.runNow(id)
    expect(await a.delete(id)).toEqual({ ok: true, message: 'deleted' })
    expect(s().list()).toMatchObject({ schedules: [], runs: [] })
    expect((await a.delete(id)).ok).toBe(false)
  })

  it('keeps an unreadable file aside', () => {
    writeFileSync(file, '{oops')
    const { s } = harness()
    expect(s().list().schedules).toEqual([])
    expect(readdirSync(dir).some((f) => f.startsWith('schedules.json.unreadable-'))).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('{oops')
  })
})
