import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  localZone,
  normalizeSchedule,
  parseSchedFile,
  planTick,
  runCost,
  runName,
  runProgress,
  runPrompt,
  runSession,
  schedView,
  withRun,
  SCHED_COST_TAIL_MS,
  SCHED_MAX,
  type Schedule,
  type SchedFile,
  type SchedList,
  type SchedRun,
  type SchedTrigger,
} from '@shared/sched'
import type { CostBook } from '@shared/costs'
import type { CliResult, Session } from '@shared/types'

/** What a tick reads: null until the first session list (nothing runs or ends before it). */
export interface SchedState {
  sessions: Session[]
  costBook: CostBook
  allStats: Record<string, { costUsd: number | null }>
}

export interface SchedStart {
  name: string
  cwd: string
  prompt: string
  model?: string
  workflow?: string
  mode?: string
  account?: string
}

export interface SchedDeps {
  now: () => number
  state: () => SchedState | null
  /** `startSession` (New Claude session's start): the bg id when claude printed it. */
  start: (r: SchedStart) => Promise<{ ok: true; bgId: string | null } | { ok: false; message: string }>
  stop: (bgId: string) => Promise<CliResult>
  notify: (n: { title: string; body: string; sessionKey: string | null }) => void
  templateName: (id: string) => string | null
  dirOk: (p: string) => boolean
  onChange: () => void
}

/** Session keys of runs this recent carry the schedule's chip in the session list. */
const TAG_MS = 30 * 86_400_000

const OVERLAP = 'the previous run is still going'

const money = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`

/**
 * Schedules (#140): `<home>/schedules.json` (schedules and their last runs, written atomically) and
 * the runner. `tick()` (every 30 s, at launch and when the Mac wakes) follows running runs, stops one
 * over its cost limit, notifies, and starts what is due; everything goes through one queue, so a
 * tick and a Run now never overlap. The file is written before a session starts: a crash between
 * the two never starts it twice.
 */
export class Scheduler {
  private data: SchedFile = { schedules: [], runs: [] }
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private file: string,
    private d: SchedDeps,
  ) {
    if (!existsSync(file)) return
    try {
      this.data = parseSchedFile(JSON.parse(readFileSync(file, 'utf8')))
    } catch (e) {
      // Not readable: kept aside rather than overwritten by the next save.
      try {
        copyFileSync(file, `${file}.unreadable-${Date.now()}`)
      } catch {}
      console.error(`schedules: ${file} could not be read (${String((e as Error)?.message ?? e).slice(0, 120)}); starting empty`)
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn)
    this.queue = p.catch(() => {})
    return p
  }

  list(): SchedList {
    const now = this.d.now()
    return {
      schedules: this.data.schedules.map((s) => schedView(s, this.data.runs, now)),
      runs: [...this.data.runs].sort((a, b) => b.startedAt - a.startedAt),
      tz: localZone(),
    }
  }

  /** Session key → its schedule, for the chip in the session list. */
  tags(): Record<string, { scheduleId: string; name: string }> {
    const since = this.d.now() - TAG_MS
    const out: Record<string, { scheduleId: string; name: string }> = {}
    for (const r of this.data.runs) if (r.bgId && r.startedAt >= since) out[r.bgId] = { scheduleId: r.scheduleId, name: r.scheduleName }
    return out
  }

  save(input: unknown): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    return this.serial(async () => {
      const id = input && typeof input === 'object' && typeof (input as { id?: unknown }).id === 'string' ? (input as { id: string }).id : null
      const prev = id ? (this.data.schedules.find((s) => s.id === id) ?? null) : null
      if (id && !prev) return { ok: false as const, message: 'that schedule is gone' }
      if (!prev && this.data.schedules.length >= SCHED_MAX) return { ok: false as const, message: `at most ${SCHED_MAX} schedules` }
      const r = normalizeSchedule(input, prev, this.d.now(), this.d.dirOk, () => randomUUID().slice(0, 8))
      if (!r.ok) return r
      this.data.schedules = prev ? this.data.schedules.map((s) => (s.id === prev.id ? r.schedule : s)) : [...this.data.schedules, r.schedule]
      // A renamed schedule's runs keep the name they ran under.
      this.write()
      return { ok: true as const, id: r.schedule.id }
    })
  }

  delete(id: string): Promise<CliResult> {
    return this.serial(async () => {
      if (!this.data.schedules.some((s) => s.id === id)) return { ok: false, message: 'that schedule is gone' }
      // Its running sessions go on; only the schedule and its history go.
      this.data = { schedules: this.data.schedules.filter((s) => s.id !== id), runs: this.data.runs.filter((r) => r.scheduleId !== id) }
      this.write()
      return { ok: true, message: 'deleted' }
    })
  }

  /** Pause or resume. Resumed, it counts from now: what it would have run while paused is not missed. */
  enable(id: string, on: boolean): Promise<CliResult> {
    return this.serial(async () => {
      const s = this.data.schedules.find((x) => x.id === id)
      if (!s) return { ok: false, message: 'that schedule is gone' }
      if (s.enabled === on) return { ok: true, message: on ? 'on' : 'paused' }
      this.patch(s.id, { enabled: on, updatedAt: this.d.now(), ...(on ? { lastSlot: this.d.now() } : {}) })
      this.write()
      return { ok: true, message: on ? 'on' : 'paused' }
    })
  }

  runNow(id: string): Promise<CliResult> {
    return this.serial(async () => {
      const s = this.data.schedules.find((x) => x.id === id)
      if (!s) return { ok: false, message: 'that schedule is gone' }
      const st = this.d.state()
      if (!st) return { ok: false, message: 'the session list is still loading; try again in a moment' }
      if (s.skipIfRunning && this.running(s.id)) return { ok: false, message: OVERLAP }
      const r = await this.startRun(s, null, 'manual', undefined, st)
      return r.status === 'failed' ? { ok: false, message: r.reason ?? 'it did not start' } : { ok: true, message: `started ${r.sessionName}` }
    })
  }

  tick(): Promise<void> {
    return this.serial(() => this.doTick())
  }

  private running(id: string): boolean {
    return this.data.runs.some((r) => r.scheduleId === id && r.status === 'running')
  }

  private async doTick(): Promise<void> {
    const st = this.d.state()
    if (!st) return
    await this.follow(st)
    // At most one catch-up run per tick across schedules: a wake never starts a burst.
    let caughtUp = false
    for (const s of [...this.data.schedules]) {
      const now = this.d.now()
      const p = planTick(s, now)
      if (p.kind === 'none') continue
      if (p.kind === 'skip') {
        this.patch(s.id, { lastSlot: p.slot })
        this.addRun(this.skipped(s, p.slot, 'missed', p.reason))
        this.write()
        continue
      }
      if (p.trigger === 'missed' && caughtUp) continue
      this.patch(s.id, { lastSlot: p.slot })
      if (s.skipIfRunning && this.running(s.id)) {
        const mine = this.data.runs.filter((r) => r.scheduleId === s.id)
        const first = mine.at(-1)?.reason !== OVERLAP
        const skip = this.skipped(s, p.slot, p.trigger, OVERLAP)
        this.addRun(skip)
        this.write()
        // Once per stretch of skips (with the failure switch): a run that never ends would otherwise
        // stop the schedule without a word.
        if (first) this.tell(skip, s)
        continue
      }
      if (p.trigger === 'missed') caughtUp = true
      await this.startRun(s, p.slot, p.trigger, p.reason, st)
    }
  }

  /** Running runs against the session list: progress, cost, the cost limit, notifications. */
  private async follow(st: SchedState): Promise<void> {
    const now = this.d.now()
    let changed = false
    for (const r of this.data.runs) {
      const live = r.status === 'running'
      if (!live && !(r.endedAt && now - r.endedAt < SCHED_COST_TAIL_MS && r.status !== 'skipped')) continue
      const s = runSession(r, st.sessions)
      const upd: Partial<SchedRun> = live ? (runProgress(r, s, now) ?? {}) : {}
      const next = { ...r, ...upd }
      const cost = runCost(next, st.costBook, st.allStats)
      if (cost !== r.costUsd) upd.costUsd = cost
      const sched = this.data.schedules.find((x) => x.id === r.scheduleId)
      if (live && next.status === 'running' && sched?.maxCostUsd && cost > sched.maxCostUsd && next.bgId) {
        const stop = await this.d.stop(next.bgId)
        // A stop that failed leaves it running: the next tick tries again.
        if (stop.ok) Object.assign(upd, { status: 'stopped', endedAt: now, reason: `over its cost limit (${money(sched.maxCostUsd)}); the session was stopped` })
        else upd.reason = `over its cost limit (${money(sched.maxCostUsd)}); stopping it failed, trying again: ${stop.message.slice(0, 200)}`
      }
      if (!Object.keys(upd).length) continue
      Object.assign(r, upd)
      changed = true
      if (live && r.status !== 'running') this.tell(r, sched ?? null)
    }
    if (changed) this.write()
  }

  private async startRun(s: Schedule, slot: number | null, trigger: SchedTrigger, reason: string | undefined, st: SchedState): Promise<SchedRun> {
    const now = this.d.now()
    const taken = new Set([
      ...st.sessions.filter((x) => x.state !== 'done').map((x) => x.name),
      ...this.data.runs.filter((r) => r.status === 'running').map((r) => r.sessionName),
    ])
    const run: SchedRun = {
      id: randomUUID().slice(0, 12),
      scheduleId: s.id,
      scheduleName: s.name,
      slot,
      trigger,
      status: 'running',
      ...(reason ? { reason } : {}),
      startedAt: now,
      endedAt: null,
      sessionName: runName(s, slot ?? now, (n) => taken.has(n)),
      bgId: null,
      sessionId: null,
      seenWorking: false,
      seen: false,
      costUsd: 0,
    }
    this.addRun(run)
    this.write()
    const wf = s.workflow ? this.d.templateName(s.workflow) : null
    let res: Awaited<ReturnType<SchedDeps['start']>>
    if (s.workflow && wf === null) res = { ok: false, message: `its workflow (${s.workflow}) no longer exists` }
    else
      try {
        res = await this.d.start({
          name: run.sessionName,
          cwd: s.cwd,
          prompt: runPrompt(s, wf),
          ...(s.model ? { model: s.model } : {}),
          ...(s.workflow ? { workflow: s.workflow } : {}),
          ...(s.mode ? { mode: s.mode } : {}),
          ...(s.account ? { account: s.account } : {}),
        })
      } catch (e) {
        res = { ok: false, message: String((e as Error)?.message ?? e) }
      }
    const r = this.data.runs.find((x) => x.id === run.id) ?? run
    if (res.ok) r.bgId = res.bgId
    else Object.assign(r, { status: 'failed', endedAt: this.d.now(), reason: res.message.slice(0, 300) || 'it did not start' })
    this.write()
    if (!res.ok) this.tell(r, s)
    return r
  }

  private tell(r: SchedRun, s: Schedule | null): void {
    if (!s) return
    const ok = r.status === 'done'
    if (ok ? !s.notify.finish : !s.notify.failure) return
    const word = ok ? 'finished' : r.status === 'stopped' ? 'stopped' : r.status === 'skipped' ? 'skipped' : 'failed'
    const took = r.endedAt ? Math.max(1, Math.round((r.endedAt - r.startedAt) / 60_000)) : null
    const body = ok ? [r.sessionName, r.costUsd ? money(r.costUsd) : null, took ? `${took} min` : null].filter(Boolean).join(' · ') : (r.reason ?? r.sessionName)
    // A skip points at the run that is still going.
    const key = r.status === 'skipped' ? (this.data.runs.find((x) => x.scheduleId === r.scheduleId && x.status === 'running')?.bgId ?? null) : r.bgId
    try {
      this.d.notify({ title: `${s.name}: ${word}`, body, sessionKey: key })
    } catch (e) {
      console.error('schedules: notify failed', e)
    }
  }

  private skipped(s: Schedule, slot: number, trigger: SchedTrigger, reason: string): SchedRun {
    const now = this.d.now()
    return { id: randomUUID().slice(0, 12), scheduleId: s.id, scheduleName: s.name, slot, trigger, status: 'skipped', reason, startedAt: now, endedAt: now, sessionName: '', bgId: null, sessionId: null, seenWorking: false, seen: false, costUsd: 0 }
  }

  private addRun(r: SchedRun): void {
    this.data.runs = withRun(this.data.runs, r)
  }

  private patch(id: string, p: Partial<Schedule>): void {
    this.data.schedules = this.data.schedules.map((s) => (s.id === id ? { ...s, ...p } : s))
  }

  private write(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, ...this.data }, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
      console.error(`schedules: could not save: ${String((e as { code?: string })?.code ?? 'error')}`)
    }
    try {
      this.d.onChange()
    } catch (e) {
      console.error('schedules: onChange failed', e)
    }
  }
}
