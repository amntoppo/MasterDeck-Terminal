import { describe, expect, it } from 'vitest'
import { duration } from './text'

const MIN = 60_000

describe('duration', () => {
  it('minutes under an hour, never negative', () => {
    expect(duration(0)).toBe('0 min')
    expect(duration(59 * 1000)).toBe('0 min')
    expect(duration(18 * MIN)).toBe('18 min')
    expect(duration(59 * MIN + 59_000)).toBe('59 min')
    expect(duration(-5 * MIN)).toBe('0 min')
  })

  it('hours and minutes under two days', () => {
    expect(duration(60 * MIN)).toBe('1 h')
    expect(duration(226 * MIN)).toBe('3 h 46 min')
    expect(duration(47 * 60 * MIN + 59 * MIN)).toBe('47 h 59 min')
  })

  it('days from two days on', () => {
    expect(duration(48 * 60 * MIN)).toBe('2 d')
    expect(duration(71 * 60 * MIN)).toBe('2 d')
    expect(duration(72 * 60 * MIN)).toBe('3 d')
  })
})
