import { describe, expect, it } from 'vitest'
import { bucketShare, bucketSpan, chartBars, customRange, customValues, DEFAULT_RANGE, hourOf, midnight, parseRange, PRESET_LABEL, PRESETS, rangeLabel, resolveRange } from './timeline'

// Local times, so day boundaries are the machine's own midnight (as in the app).
const at = (month: number, day: number, h = 0, m = 0) => new Date(2026, month - 1, day, h, m).getTime()
const HOUR = 3_600_000
const NOW = at(10, 9, 14, 30)

describe('buckets', () => {
  it('names the local hour and reads back its span, and a day', () => {
    expect(hourOf(at(10, 9, 7, 59))).toBe('2026-10-09T07')
    expect(bucketSpan('2026-10-09T07')).toEqual([at(10, 9, 7), at(10, 9, 8)])
    expect(bucketSpan('2026-10-09')).toEqual([at(10, 9), at(10, 10)])
    expect(bucketSpan('0000-baseline')).toBeNull()
  })
  it('shares a bucket by time, the running one only up to now', () => {
    expect(bucketShare('2026-10-09T13', at(10, 9, 13, 30), NOW, NOW)).toBeCloseTo(0.5)
    expect(bucketShare('2026-10-09T14', at(10, 9, 14), NOW, NOW)).toBe(1)
    expect(bucketShare('2026-10-09T14', at(10, 9, 14, 15), NOW, NOW)).toBeCloseTo(0.5)
    expect(bucketShare('2026-10-09', at(10, 9, 12), at(10, 10), at(10, 11))).toBeCloseTo(0.5)
    expect(bucketShare('2026-10-08T23', at(10, 9), NOW, NOW)).toBe(0)
    expect(bucketShare('0000-baseline', 0, NOW, NOW)).toBe(0)
  })
})

describe('ranges', () => {
  it('has every preset of the issue, in order', () => {
    expect(PRESETS.map((p) => PRESET_LABEL[p])).toEqual(['Last 1 hour', 'Last 5 hours', 'Last 12 hours', 'Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'All time', 'Custom…'])
  })
  it('resolves presets in local time', () => {
    expect(resolveRange({ preset: '1h' }, NOW)).toEqual({ from: NOW - HOUR, to: NOW })
    expect(resolveRange({ preset: '5h' }, NOW)).toEqual({ from: NOW - 5 * HOUR, to: NOW })
    expect(resolveRange({ preset: '12h' }, NOW)).toEqual({ from: NOW - 12 * HOUR, to: NOW })
    expect(resolveRange({ preset: 'today' }, NOW)).toEqual({ from: at(10, 9), to: NOW })
    expect(resolveRange({ preset: 'yesterday' }, NOW)).toEqual({ from: at(10, 8), to: at(10, 9) })
    expect(resolveRange({ preset: '7d' }, NOW)).toEqual({ from: at(10, 3), to: NOW })
    expect(resolveRange({ preset: '30d' }, NOW)).toEqual({ from: at(9, 10), to: NOW })
    expect(resolveRange({ preset: 'all' }, NOW)).toEqual({ from: 0, to: NOW })
    expect(resolveRange({ preset: 'custom', from: 5, to: 9 }, NOW)).toEqual({ from: 5, to: 9 })
  })
  it('yesterday across a month start', () => {
    expect(resolveRange({ preset: 'yesterday' }, at(11, 1, 9))).toEqual({ from: at(10, 31), to: at(11, 1) })
    expect(midnight(at(3, 1, 5), -1)).toBe(at(2, 28))
  })
  it('reads a saved choice, falling back to Last 7 days', () => {
    expect(parseRange({ preset: 'today' })).toEqual({ preset: 'today' })
    expect(parseRange({ preset: 'custom', from: 1, to: 2 })).toEqual({ preset: 'custom', from: 1, to: 2 })
    expect(parseRange({ preset: 'custom', from: 2, to: 1 })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ preset: 'custom', from: 1 })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ preset: 'week' })).toEqual(DEFAULT_RANGE)
    expect(parseRange(null)).toEqual({ preset: '7d' })
  })
})

describe('custom ranges', () => {
  it('takes the end as the last minute that counts', () => {
    expect(customRange('2026-10-03T00:00', '2026-10-09T23:59')).toEqual({ range: { preset: 'custom', from: at(10, 3), to: at(10, 10) } })
    expect(customValues({ from: at(10, 3), to: at(10, 10) })).toEqual({ from: '2026-10-03T00:00', to: '2026-10-09T23:59' })
  })
  it('rejects an end before the start, and a missing value', () => {
    expect(customRange('2026-10-09T10:00', '2026-10-09T09:59')).toEqual({ error: 'The end is before the start.' })
    expect(customRange('', '2026-10-09T09:59')).toEqual({ error: 'Pick a start and an end.' })
    expect(customRange('2026-10-09T10:00', '2026-10-09T10:00')).toHaveProperty('range')
  })
  it('labels whole days as dates, anything else with times', () => {
    expect(rangeLabel({ preset: '7d' }, NOW)).toBe('Last 7 days')
    expect(rangeLabel({ preset: 'custom', from: at(10, 3), to: at(10, 10) }, NOW)).toBe('3 Oct – 9 Oct')
    expect(rangeLabel({ preset: 'custom', from: at(10, 3), to: at(10, 4) }, NOW)).toBe('3 Oct')
    expect(rangeLabel({ preset: 'custom', from: at(10, 3, 9), to: at(10, 3, 17, 30) }, NOW)).toBe('3 Oct 09:00 – 17:30')
    expect(rangeLabel({ preset: 'custom', from: at(10, 3, 9), to: at(10, 5, 17) }, NOW)).toBe('3 Oct 09:00 – 5 Oct 17:00')
    expect(rangeLabel({ preset: 'custom', from: new Date(2025, 11, 30).getTime(), to: at(1, 3) }, NOW)).toBe('30 Dec 2025 – 2 Jan')
  })
})

describe('chartBars', () => {
  it('hours for a short range, the running one marked', () => {
    const { unit, bars } = chartBars(NOW - 5 * HOUR, NOW, NOW)
    expect(unit).toBe('hour')
    expect(bars.map((b) => b.label)).toEqual(['09', '10', '11', '12', '13', '14'])
    expect(bars.filter((b) => b.current).map((b) => b.label)).toEqual(['14'])
  })
  it('days for a month, weeks from Monday beyond two months, months beyond a year', () => {
    const days = chartBars(at(9, 10), NOW, NOW)
    expect(days.unit).toBe('day')
    expect(days.bars).toHaveLength(30)
    expect(days.bars[0]).toMatchObject({ start: at(9, 10), end: at(9, 11), label: '10' })
    const weeks = chartBars(at(6, 3), NOW, NOW)
    expect(weeks.unit).toBe('week')
    // 3 Jun 2026 is a Wednesday: the first week starts on Monday 1 Jun.
    expect(weeks.bars[0]).toMatchObject({ start: at(6, 1), label: '1 Jun' })
    expect(chartBars(new Date(2024, 0, 15).getTime(), NOW, NOW).bars[0]).toMatchObject({ start: new Date(2024, 0, 1).getTime(), label: 'Jan' })
  })
})
