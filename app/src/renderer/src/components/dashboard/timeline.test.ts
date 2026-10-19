import { describe, expect, it } from 'vitest'
import { ACTIVITY_COALESCE_MS } from '@shared/activityLog'
import { ACTIVITY_LATE_MS, cleanTimeline, DEFAULT_TIMELINE, timelineSince } from './timeline'

describe('cleanTimeline', () => {
  it('anything unreadable is the default', () => {
    expect(cleanTimeline(null)).toBe(DEFAULT_TIMELINE)
    expect(cleanTimeline('today')).toBe(DEFAULT_TIMELINE)
    expect(cleanTimeline(7)).toBe(DEFAULT_TIMELINE)
  })

  it('keeps known values', () => {
    const groups = cleanTimeline({ groups: ['x'] }).groups
    expect(groups).toEqual([])
    const ok = cleanTimeline({ range: '7d', groups: [], account: 'octo', repo: 'acme/api' })
    expect(ok).toEqual({ range: '7d', groups: [], account: 'octo', repo: 'acme/api' })
    expect(cleanTimeline({ range: 'yesterday' }).range).toBe('yesterday')
  })

  it('drops unknown ranges, groups and junk, and cuts long strings', () => {
    const r = cleanTimeline({ range: 'month', groups: ['nope', 3, null], account: '', repo: 'r'.repeat(500) })
    expect(r.range).toBe('today')
    expect(r.groups).toEqual([])
    expect(r.account).toBeNull()
    expect(r.repo).toHaveLength(200)
  })

  it('a known group is kept once', async () => {
    const { ACTIVITY_GROUPS } = await import('@shared/activityLog')
    const g = ACTIVITY_GROUPS[0].id
    expect(cleanTimeline({ groups: [g, g, 'nope'] }).groups).toEqual([g])
  })
})

describe('timelineSince', () => {
  const now = Date.UTC(2026, 9, 19, 15, 0)
  const from = Date.UTC(2026, 9, 19, 0, 0)

  it('reads from an hour and a quarter back when the newest event is recent', () => {
    // An event backdated by up to an hour (a merge seen late) is still read.
    expect(timelineSince(from, now - 60_000, now)).toBe(now - ACTIVITY_LATE_MS)
    expect(ACTIVITY_LATE_MS).toBe(75 * 60_000)
  })

  it('reads from 15 minutes before the newest event when that is earlier', () => {
    const newest = now - 3 * 3_600_000
    expect(timelineSince(from, newest, now)).toBe(newest - ACTIVITY_COALESCE_MS)
  })

  it('never before the range starts', () => {
    expect(timelineSince(now - 10 * 60_000, now - 60_000, now)).toBe(now - 10 * 60_000)
    expect(timelineSince(from, undefined, now)).toBe(from)
  })
})
