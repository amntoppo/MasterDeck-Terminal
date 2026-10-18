import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityLog } from './activityLog'
import { ACTIVITY_COALESCE_MS, ACTIVITY_MAX_LINES, type ActivityEvent } from '@shared/activityLog'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 18, 12)

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-activity-'))
  file = join(dir, 'activity.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
const ev = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${++seq}`,
  at: NOW,
  type: 'session-started',
  title: 'Session api started',
  subject: `session:k${seq}`,
  ...over,
})
const lines = () => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ActivityEvent)
const writeLines = (rows: unknown[]) => writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n')

describe('ActivityLog', () => {
  it('appends one JSON line per add', () => {
    const log = new ActivityLog(file, { now: () => NOW })
    const e = ev()
    log.add(e)
    expect(lines()).toEqual([e])
    log.add(ev({ at: NOW + 1 }))
    expect(lines()).toHaveLength(2)
  })

  it('lists newest first, within since..until, bounded by limit', () => {
    const log = new ActivityLog(file, { now: () => NOW })
    for (let i = 9; i >= 0; i--) log.add(ev({ at: NOW - i * 60_000 }))
    log.add(ev({ at: NOW - 5 * 60_000 - 1 }))
    const all = log.list(0, NOW)
    expect(all).toHaveLength(11)
    expect(all.map((e) => e.at)).toEqual([...all.map((e) => e.at)].sort((a, b) => b - a))
    expect(log.list(NOW - 3 * 60_000, NOW - 60_000).map((e) => e.at)).toEqual([NOW - 60_000, NOW - 2 * 60_000, NOW - 3 * 60_000])
    expect(log.list(0, NOW, 4).map((e) => e.at)).toEqual([NOW, NOW - 60_000, NOW - 2 * 60_000, NOW - 3 * 60_000])
    expect(log.list(0, NOW, 5000)).toHaveLength(11)
    expect(log.list(NOW, 0)).toEqual([])
  })

  it('reads the file back in a new instance', () => {
    const a = new ActivityLog(file, { now: () => NOW })
    a.add(ev({ at: NOW - 2000 }))
    a.add(ev({ at: NOW - 1000 }))
    const b = new ActivityLog(file, { now: () => NOW })
    expect(b.list(0, NOW).map((e) => e.at)).toEqual([NOW - 1000, NOW - 2000])
  })

  it('trims on load: older than 14 days and past 5000 lines, rewritten through a .tmp', () => {
    const old = ev({ at: NOW - 15 * DAY })
    const rows: ActivityEvent[] = [old]
    for (let i = 0; i < ACTIVITY_MAX_LINES + 10; i++) rows.push(ev({ at: NOW - DAY + i }))
    writeLines(rows)
    const log = new ActivityLog(file, { now: () => NOW })
    expect(log.list(0, NOW)[0].at).toBe(NOW - DAY + ACTIVITY_MAX_LINES + 9)
    const disk = lines()
    expect(disk).toHaveLength(ACTIVITY_MAX_LINES)
    expect(disk.some((e) => e.id === old.id)).toBe(false)
    // the oldest of the recent ones went, the newest stayed, the file stays oldest first
    expect(disk[0].at).toBe(NOW - DAY + 10)
    expect(disk[disk.length - 1].at).toBe(NOW - DAY + ACTIVITY_MAX_LINES + 9)
    expect(readdirSync(dir)).toEqual(['activity.jsonl'])
  })

  it('leaves a clean file alone', () => {
    writeLines([ev({ at: NOW - 2 }), ev({ at: NOW - 1 })])
    const before = readFileSync(file, 'utf8')
    new ActivityLog(file, { now: () => NOW })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('skips a corrupt line and rewrites the file without it', () => {
    const a = ev({ at: NOW - 2 })
    const b = ev({ at: NOW - 1 })
    writeLines([a, '{not json', { ...ev(), type: 'nonsense' }, b])
    const log = new ActivityLog(file, { now: () => NOW })
    expect(log.list(0, NOW).map((e) => e.id)).toEqual([b.id, a.id])
    expect(lines()).toEqual([a, b])
    expect(readdirSync(dir)).toEqual(['activity.jsonl'])
  })

  it('coalesces in memory: two adds within 15 minutes give one row', () => {
    const log = new ActivityLog(file, { now: () => NOW })
    const first = ev({ type: 'session-finished', subject: 'session:k', at: NOW - 60_000, title: 'one' })
    log.add(first)
    log.add(ev({ type: 'session-finished', subject: 'session:k', at: NOW, title: 'two' }))
    const rows = log.list(0, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: first.id, at: NOW, title: 'two' })
    expect(lines()).toHaveLength(2)
    log.add(ev({ type: 'session-finished', subject: 'session:k', at: NOW + ACTIVITY_COALESCE_MS + 1 }))
    expect(log.list(0, NOW + DAY)).toHaveLength(2)
  })

  it('coalesces after a reload: the newer line wins', () => {
    const first = ev({ type: 'session-finished', subject: 'session:k', at: NOW - 60_000, title: 'one' })
    writeLines([first, ev({ type: 'session-finished', subject: 'session:k', at: NOW, title: 'two' })])
    const log = new ActivityLog(file, { now: () => NOW })
    const rows = log.list(0, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ at: NOW, title: 'two' })
  })

  it('swallows a write failure; a later add still lands in memory', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'a file, not a folder')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let t = NOW
      const log = new ActivityLog(join(blocker, 'activity.jsonl'), { now: () => t })
      expect(() => log.add(ev())).not.toThrow()
      t += 1000
      expect(() => log.add(ev({ at: t }))).not.toThrow()
      expect(log.list(0, t)).toHaveLength(2)
      // logged once a minute, never with the path
      expect(err).toHaveBeenCalledTimes(1)
      expect(String(err.mock.calls[0])).not.toContain(dir)
      t += 61_000
      log.add(ev({ at: t }))
      expect(err).toHaveBeenCalledTimes(2)
      expect(String(err.mock.calls[1])).not.toContain(dir)
    } finally {
      err.mockRestore()
    }
  })

  it('never throws from its constructor or list', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // a folder where the file should be: unreadable as a file
      const log = new ActivityLog(dir, { now: () => NOW })
      expect(log.list(0, NOW)).toEqual([])
      expect(log.list(Number.NaN, NOW)).toEqual([])
    } finally {
      err.mockRestore()
    }
  })

  it('drops an event that does not pass the line check', () => {
    const log = new ActivityLog(file, { now: () => NOW })
    log.add({ ...ev(), type: 'bogus' } as unknown as ActivityEvent)
    expect(log.list(0, NOW)).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('keeps memory bounded to 5000 events', () => {
    const log = new ActivityLog(file, { now: () => NOW })
    for (let i = 0; i < ACTIVITY_MAX_LINES + 5; i++) log.add(ev({ at: NOW - DAY + i }))
    expect(log.size).toBe(ACTIVITY_MAX_LINES)
  })

  it('throttles onChange to once per 2 s', () => {
    let t = NOW
    const timers: { fn: () => void; ms: number }[] = []
    const onChange = vi.fn()
    const log = new ActivityLog(file, { now: () => t, onChange, setTimer: (fn, ms) => void timers.push({ fn, ms }) })
    log.add(ev({ at: t }))
    expect(onChange).toHaveBeenCalledTimes(1)
    t += 500
    log.add(ev({ at: t }))
    log.add(ev({ at: t }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(1500)
    t += 1500
    timers[0].fn()
    expect(onChange).toHaveBeenCalledTimes(2)
    t += 100
    log.add(ev({ at: t }))
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(timers).toHaveLength(2)
    expect(timers[1].ms).toBe(1900)
    t += 5000
    timers[1].fn()
    expect(onChange).toHaveBeenCalledTimes(3)
    t += 5000
    log.add(ev({ at: t }))
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('keeps a throwing onChange from reaching the caller', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const log = new ActivityLog(file, { now: () => NOW, onChange: () => { throw new Error('boom') } })
      expect(() => log.add(ev())).not.toThrow()
      expect(log.list(0, NOW)).toHaveLength(1)
    } finally {
      err.mockRestore()
    }
  })
})
