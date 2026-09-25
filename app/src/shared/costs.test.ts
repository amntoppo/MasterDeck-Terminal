import { describe, expect, it } from 'vitest'
import { dailySpend, dayOf, pruneBook, recordCosts, sessionSpendBetween, sessionTotal, sumBetween, ticketSpend, validBook, type CostBook } from './costs'

const e = (sessionId: string, cost: number, issue: number | null = 7) => ({ sessionId, name: sessionId, key: sessionId, issue, cost })

describe('costs', () => {
  it('keeps the highest cumulative cost per day and computes day spend', () => {
    const b: CostBook = {}
    expect(recordCosts(b, [e('a', 1)], '2026-09-23')).toBe(true)
    recordCosts(b, [e('a', 3)], '2026-09-23')
    recordCosts(b, [e('a', 2.5)], '2026-09-23') // lower reading later the same day: ignored
    recordCosts(b, [e('a', 5)], '2026-09-24')
    expect(recordCosts(b, [e('a', 5)], '2026-09-24')).toBe(false)
    expect(dailySpend(b)).toEqual({ '2026-09-23': 3, '2026-09-24': 2 })
    expect(sessionTotal(b.a)).toBe(5)
  })
  it('accounts a resumed session (new id, from zero) separately, never negative', () => {
    const b: CostBook = {}
    recordCosts(b, [e('old', 10)], '2026-09-23')
    recordCosts(b, [e('new', 1)], '2026-09-24')
    expect(dailySpend(b)).toEqual({ '2026-09-23': 10, '2026-09-24': 1 })
    expect(ticketSpend(b)).toEqual({ 7: 11 })
  })
  it('sums by ticket and by range', () => {
    const b: CostBook = {}
    recordCosts(b, [e('a', 4, 1), e('b', 6, 1), e('c', 2, null)], '2026-09-24')
    expect(ticketSpend(b)).toEqual({ 1: 10 })
    const daily = dailySpend(b)
    expect(sumBetween(daily, '2026-09-24', '2026-09-24')).toBe(12)
    expect(sessionSpendBetween(b.a, '2026-09-25', '2026-09-30')).toBe(0)
  })
  it('pruning folds old days into the baseline, so later spend and totals stay right', () => {
    const b: CostBook = {}
    recordCosts(b, [e('a', 10)], '2026-01-01')
    recordCosts(b, [e('a', 12)], '2026-09-24')
    pruneBook(b, '2026-09-25', 30)
    expect(b.a.days).toEqual({ '0000-baseline': 10, '2026-09-24': 12 })
    expect(dailySpend(b)).toEqual({ '2026-09-24': 2 })
    expect(sessionTotal(b.a)).toBe(12)
  })
  it('validBook drops malformed records', () => {
    expect(validBook({ a: { name: 'x', days: { '2026-09-24': 3, bad: 'y' } }, b: { name: 'no days' }, c: null })).toEqual({
      a: { name: 'x', key: 'a', issue: null, days: { '2026-09-24': 3 } },
    })
  })
  it('dayOf formats the local date', () => {
    expect(dayOf(new Date(2026, 8, 5, 23, 59).getTime())).toBe('2026-09-05')
  })
  it('a first sighting of an older session is a baseline, not today\'s spend', () => {
    const b: CostBook = {}
    const today = Date.parse('2026-09-25T00:00:00')
    recordCosts(b, [{ ...e('old', 100), startedAt: today - 86_400_000 }, { ...e('new', 2), startedAt: today + 3_600_000 }], '2026-09-25', today)
    expect(dailySpend(b)).toEqual({ '2026-09-25': 2 })
    recordCosts(b, [{ ...e('old', 104), startedAt: today - 86_400_000 }], '2026-09-25', today)
    expect(dailySpend(b)).toEqual({ '2026-09-25': 6 })
    expect(sessionTotal(b.old)).toBe(104)
    expect(ticketSpend(b)).toEqual({ 7: 106 })
    expect(sessionSpendBetween(b.old, '0000-00-00', '2026-09-25')).toBe(104)
    expect(sessionSpendBetween(b.old, '2026-09-01', '2026-09-25')).toBe(4)
  })
})
