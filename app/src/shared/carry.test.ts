import { describe, expect, it } from 'vitest'
import { linksToCarry, recordHistory, type LinkInfo, type SessionHistory } from './carry'
import type { Session } from './types'

const T = 1_790_000_000_000
const bg = (p: Partial<Session>): Session => ({
  key: 'a4ece16d', sessionId: 'new', name: 'app-cancellation-flow', kind: 'background', bgId: 'a4ece16d', pid: 1,
  cwd: '/w', state: 'idle', rawState: 'idle', startedAt: T, issue: null, ...p,
})
const links = (e: [string, LinkInfo][]) => new Map(e)

describe('recordHistory', () => {
  it('collects every session id per background id, once', () => {
    const h: SessionHistory = {}
    expect(recordHistory(h, [bg({ sessionId: 'old' })])).toBe(true)
    expect(recordHistory(h, [bg({ sessionId: 'old' })])).toBe(false)
    recordHistory(h, [bg({ sessionId: 'new' }), { ...bg({ sessionId: 'i1' }), kind: 'interactive', bgId: null }])
    expect(h).toEqual({ a4ece16d: ['old', 'new'] })
  })
  it('seeds the original id from linked ids that start with the background id', () => {
    const h: SessionHistory = {}
    recordHistory(h, [bg({ sessionId: 'b125e8ba-x' })], ['a4ece16d-1111-2222', 'ffff0000-1111'])
    expect(h).toEqual({ a4ece16d: ['a4ece16d-1111-2222', 'b125e8ba-x'] })
  })
})

describe('linksToCarry', () => {
  const h: SessionHistory = { a4ece16d: ['old', 'new'] }
  it('carries the old link to a resumed session that has none', () => {
    expect(linksToCarry(h, [bg({})], links([['old', { issue: 42, linkedAt: T - 86_400_000 }]]))).toEqual([
      { bgId: 'a4ece16d', sessionId: 'new', issue: 42, cwd: '/w', replaces: null },
    ])
  })
  it('replaces the automatic branch link made right at the resume (the #967 case)', () => {
    const l = links([['old', { issue: 42, linkedAt: T - 86_400_000 }], ['new', { issue: 967, linkedAt: T + 5_000 }]])
    expect(linksToCarry(h, [bg({})], l)[0]).toMatchObject({ issue: 42, replaces: 967 })
  })
  it('leaves a link made on purpose later, and a link that already matches', () => {
    const later = links([['old', { issue: 42, linkedAt: T - 1 }], ['new', { issue: 7, linkedAt: T + 3_600_000 }]])
    expect(linksToCarry(h, [bg({})], later)).toEqual([])
    const same = links([['old', { issue: 42, linkedAt: T - 1 }], ['new', { issue: 42, linkedAt: T + 1 }]])
    expect(linksToCarry(h, [bg({})], same)).toEqual([])
  })
  it('uses the most recent of several earlier links, and ignores sessions with no history', () => {
    const h3: SessionHistory = { a4ece16d: ['a', 'b', 'new'] }
    const l = links([['a', { issue: 1, linkedAt: T - 100 }], ['b', { issue: 2, linkedAt: T - 10 }]])
    expect(linksToCarry(h3, [bg({})], l)[0].issue).toBe(2)
    expect(linksToCarry({}, [bg({})], l)).toEqual([])
  })
  it('skips interactive and done sessions', () => {
    const l = links([['old', { issue: 42, linkedAt: 1 }]])
    expect(linksToCarry(h, [bg({ state: 'done' })], l)).toEqual([])
    expect(linksToCarry(h, [{ ...bg({}), kind: 'interactive', bgId: null }], l)).toEqual([])
  })
})
