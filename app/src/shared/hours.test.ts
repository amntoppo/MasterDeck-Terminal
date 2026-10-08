import { describe, expect, it } from 'vitest'
import { parseConfig } from './appConfig'
import { accountTotals, estimateHours, formatHours, hoursAccount, hoursCsv, mergeSpans, minutesByDay, type HoursSession } from './hours'
import type { Span } from './tokens'

// Local times, so day boundaries are the machine's own midnight (as in the app).
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()
const span = (day: number, h1: number, m1: number, h2: number, m2: number): Span => [at(day, h1, m1), at(day, h2, m2)]
const HOUR = 60 * 60_000
const ALL = { idleGapMs: HOUR, from: '0000-00-00', to: '9999-99-99' }
const s = (id: string, account: string | null, ticket: string | null, spans: Span[]): HoursSession => ({ id, account, ticket, spans })

describe('mergeSpans', () => {
  it('joins spans within the gap, in order', () => {
    expect(mergeSpans([span(1, 11, 0, 11, 30), span(1, 10, 0, 10, 20), span(1, 13, 0, 13, 5)], HOUR)).toEqual([span(1, 10, 0, 11, 30), span(1, 13, 0, 13, 5)])
  })
})

describe('minutesByDay', () => {
  it('cuts at local midnight', () => {
    expect(minutesByDay([[at(1, 23, 30), at(2, 0, 45)]])).toEqual({ '2026-10-01': 30, '2026-10-02': 45 })
  })
})

describe('estimateHours', () => {
  it('fills gaps up to the idle gap and drops longer ones', () => {
    // 10:00–10:30, 50 min idle, 11:20–11:40 → 100 min; then 2 h idle, 13:40–14:00 → 20 min.
    const r = estimateHours([s('a', 'alice', null, [span(1, 10, 0, 10, 30), span(1, 11, 20, 11, 40), span(1, 13, 40, 14, 0)])], ALL)
    expect(r.accounts).toEqual([{ day: '2026-10-01', account: 'alice', ticket: null, minutes: 120 }])
    // No ticket: counted for the account only.
    expect(r.tickets).toEqual([])
  })

  it('a smaller idle gap leaves the 50 minutes out', () => {
    const r = estimateHours([s('a', 'alice', null, [span(1, 10, 0, 10, 30), span(1, 11, 20, 11, 40)])], { ...ALL, idleGapMs: 15 * 60_000 })
    expect(r.accounts[0].minutes).toBe(50)
  })

  it('overlap: each ticket gets its full time, the account counts the minute once', () => {
    const r = estimateHours(
      [
        s('a', 'alice', 'acme/web#12', [span(1, 10, 0, 11, 0)]),
        s('b', 'alice', 'acme/api#3', [span(1, 10, 0, 10, 30), span(1, 10, 50, 11, 0)]),
        // A third session on #12 at the same time adds nothing to the ticket either.
        s('c', 'alice', 'acme/web#12', [span(1, 10, 30, 11, 0)]),
      ],
      ALL,
    )
    expect(r.accounts).toEqual([{ day: '2026-10-01', account: 'alice', ticket: null, minutes: 60 }])
    expect(r.tickets).toEqual([
      { day: '2026-10-01', account: 'alice', ticket: 'acme/api#3', minutes: 60 },
      { day: '2026-10-01', account: 'alice', ticket: 'acme/web#12', minutes: 60 },
    ])
  })

  it('keeps accounts apart, counts an unknown account, and splits a day boundary', () => {
    const r = estimateHours(
      [
        s('a', 'alice', 'acme/web#12', [span(1, 9, 0, 10, 0)]),
        s('b', 'bob-work', 'globex/app#7', [span(1, 9, 30, 10, 0)]),
        s('c', null, null, [[at(1, 23, 0), at(2, 1, 15)]]),
      ],
      ALL,
    )
    expect(r.accounts).toEqual([
      { day: '2026-10-02', account: null, ticket: null, minutes: 75 },
      { day: '2026-10-01', account: 'alice', ticket: null, minutes: 60 },
      { day: '2026-10-01', account: 'bob-work', ticket: null, minutes: 30 },
      { day: '2026-10-01', account: null, ticket: null, minutes: 60 },
    ])
    expect(accountTotals(r.accounts).get(null)).toBe(135)
    expect(r.tickets).toHaveLength(2)
  })

  it('returns only days in the range', () => {
    const r = estimateHours([s('a', 'alice', 'acme/web#12', [[at(1, 23, 0), at(2, 1, 0)]])], { ...ALL, from: '2026-10-02', to: '2026-10-02' })
    expect(r.accounts).toEqual([{ day: '2026-10-02', account: 'alice', ticket: null, minutes: 60 }])
    expect(r.tickets).toEqual([{ day: '2026-10-02', account: 'alice', ticket: 'acme/web#12', minutes: 60 }])
  })

  it('a lone line adds nothing', () => {
    expect(estimateHours([s('a', 'alice', null, [[at(1, 10), at(1, 10)]])], ALL).accounts).toEqual([])
  })
})

describe('hoursCsv', () => {
  it('writes the account total, then its tickets, per day', () => {
    const r = estimateHours([s('a', 'alice', 'acme/web#12', [span(1, 10, 0, 10, 40)]), s('b', null, 'x,y', [span(1, 10, 0, 10, 10)])], ALL)
    expect(hoursCsv(r)).toBe(
      ['date,account,ticket,minutes', '2026-10-01,alice,(account total),40', '2026-10-01,alice,acme/web#12,40', '2026-10-01,unknown account,(account total),10', '2026-10-01,unknown account,"x,y",10', ''].join('\n'),
    )
  })
})

describe('hoursAccount', () => {
  const acct = (login: string, owner: string, repos: string[], primary = false) => ({ login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repos[0].split('/')[1], repos, projects: [], ...(primary ? { primary: true } : {}) })
  const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/tracker'], true), acct('bob-work', 'globex', ['globex/app'])] })
  const one = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/tracker'], true)] })
  it('the recorded account, else the repository’s, else the only one; never the primary as a guess', () => {
    expect(hoursAccount({ recorded: 'bob-work', origin: 'acme/tracker' }, two)).toBe('bob-work')
    expect(hoursAccount({ recorded: 'gone-away', origin: 'globex/app' }, two)).toBe('bob-work')
    expect(hoursAccount({ recorded: null, origin: 'initech/x' }, two)).toBeNull()
    expect(hoursAccount({ recorded: null, origin: null }, two)).toBeNull()
    expect(hoursAccount({ recorded: null, origin: null }, one)).toBe('alice')
  })
})

describe('formatHours', () => {
  it('reads as hours and minutes', () => {
    expect(formatHours(40)).toBe('40 min')
    expect(formatHours(185.4)).toBe('3 h 05 min')
  })
})
