import { describe, expect, it } from 'vitest'
import { jobName, liveSchedules, readable, newScheduleScan, nextRun, RECURRING_MS, scanScheduleLines } from './schedules'

const T0 = '2026-09-30T10:00:30.000Z'
const use = (id: string, name: string, input: object, ts = T0) =>
  JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } })
const res = (id: string, text: string, ts = T0) =>
  JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

describe('scheduled jobs from the transcript', () => {
  it('adds a job from CronCreate and drops it on CronDelete', () => {
    const s = newScheduleScan()
    scanScheduleLines(
      [
        use('u1', 'CronCreate', { cron: '*/2 * * * *', prompt: 'App Store Connect accept-watch. Reload page 1' }),
        res('u1', 'Scheduled recurring job dc9f721b (Every 2 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days.'),
        use('u2', 'CronCreate', { cron: '3-59/10 * * * *', prompt: 'App Store Connect accept-watch v2 (chrome-devtools MCP)' }),
        res('u2', 'Scheduled recurring job a782a417 (3-59/10 * * * *). Session-only (not written to disk, dies when Claude exits).'),
        use('u3', 'CronDelete', { id: 'dc9f721b' }),
        res('u3', 'Cancelled dc9f721b'),
      ],
      s,
    )
    expect(Object.keys(s.jobs)).toEqual(['a782a417'])
    const [j] = liveSchedules(s, Date.parse(T0) + 1000)
    expect(j).toMatchObject({ id: 'a782a417', when: 'Every 10 minutes from :03', recurring: true, sessionOnly: true })
    expect(new Date(j.nextAt!).getMinutes() % 10).toBe(3)
    expect(j.expiresAt).toBe(Date.parse(T0) + RECURRING_MS)
    expect(jobName(j.prompt)).toBe('App Store Connect accept-watch v2')
  })
  it('a failed call adds nothing; a recurring job ends after 7 days; a one-time job once its time passed', () => {
    const made = local(2026, 9, 30, 10, 0)
    const ts = new Date(made).toISOString()
    const s = newScheduleScan()
    scanScheduleLines(
      [
        use('a', 'CronCreate', { cron: 'bad', prompt: 'x' }, ts),
        JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Invalid cron' }] } }),
        use('b', 'CronCreate', { cron: '0 9 * * *', prompt: 'standup' }, ts),
        res('b', 'Scheduled recurring job b1b1b1b1 (Every day at 9am).', ts),
        use('c', 'CronCreate', { cron: '30 10 30 9 *', prompt: 'once', recurring: false }, ts),
        res('c', 'Scheduled one-time job c2c2c2c2 (Sep 30 at 10:30).', ts),
      ],
      s,
    )
    expect(liveSchedules(s, made + 60_000).map((j) => j.id)).toEqual(['c2c2c2c2', 'b1b1b1b1'])
    expect(s.jobs.c2c2c2c2).toMatchObject({ recurring: false, sessionOnly: false })
    expect(liveSchedules(s, local(2026, 9, 30, 10, 33)).map((j) => j.id)).toEqual(['b1b1b1b1'])
    expect(liveSchedules(s, made + RECURRING_MS).map((j) => j.id)).toEqual([])
  })
})

describe('readable', () => {
  it('keeps Claude Code wording, else names common crons', () => {
    expect(readable('Every 2 minutes', '*/2 * * * *')).toBe('Every 2 minutes')
    expect(readable('', '*/5 * * * *')).toBe('Every 5 minutes')
    expect(readable('7 * * * *', '7 * * * *')).toBe('Every hour at :07')
    expect(readable('', '30 9 * * *')).toBe('Every day at 09:30')
    expect(readable('', '0 9 * * 1-5')).toBe('0 9 * * 1-5')
  })
})

describe('nextRun', () => {
  it('steps, ranges, lists and days', () => {
    expect(nextRun('*/15 * * * *', local(2026, 9, 30, 10, 7))).toBe(local(2026, 9, 30, 10, 15))
    expect(nextRun('3-59/10 * * * *', local(2026, 9, 30, 10, 3))).toBe(local(2026, 9, 30, 10, 13))
    expect(nextRun('0 9 * * 1-5', local(2026, 10, 2, 10, 0))).toBe(local(2026, 10, 5, 9, 0)) // Fri after 9 → Mon
    expect(nextRun('0 0 1 * *', local(2026, 9, 30, 10, 0))).toBe(local(2026, 10, 1, 0, 0))
    expect(nextRun('nonsense', 0)).toBeNull()
    expect(nextRun('61 * * * *', 0)).toBeNull()
  })
})
