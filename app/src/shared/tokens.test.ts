import { describe, expect, it } from 'vitest'
import { formatTokens, newFileTally, tallyLines, tokenSum, tokensBetween, totalOf } from './tokens'

const line = (id: string, ts: string, u: Record<string, number>) => JSON.stringify({ timestamp: ts, message: { id, role: 'assistant', usage: u } })
const U = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }

describe('tokens', () => {
  it('counts each message once, however many lines repeat it', () => {
    const t = newFileTally()
    tallyLines(t, [line('m1', '2026-09-25T10:00:00Z', U), line('m1', '2026-09-25T10:00:00Z', U), '{"type":"user"}', 'not json "usage"', line('m2', '2026-09-25T11:00:00Z', U)])
    expect(totalOf(t.byDay)).toEqual({ input: 20, output: 10, cacheWrite: 200, cacheRead: 2000 })
    // A repeat arriving in the next read is still recognized.
    tallyLines(t, [line('m2', '2026-09-25T11:00:00Z', U)])
    expect(tokenSum(totalOf(t.byDay))).toBe(2230)
  })
  it('buckets by the day of each message', () => {
    const t = newFileTally()
    tallyLines(t, [line('a', '2026-09-20T12:00:00Z', U), line('b', '2026-09-25T12:00:00Z', U)])
    const days = Object.keys(t.byDay).sort()
    expect(days).toHaveLength(2)
    expect(tokenSum(tokensBetween(t.byDay, days[1], days[1]))).toBe(1115)
    expect(tokenSum(tokensBetween(t.byDay, '0000-00-00', '9999-99-99'))).toBe(2230)
  })
  it('formats large counts compactly', () => {
    expect(formatTokens(null)).toBe('—')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_345)).toBe('12k')
    expect(formatTokens(32_169_536)).toBe('32.2M')
    expect(formatTokens(2_500_000_000)).toBe('2.50B')
  })
})
