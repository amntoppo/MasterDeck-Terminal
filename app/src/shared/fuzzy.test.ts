import { describe, expect, it } from 'vitest'
import { fuzzyScore, rank } from './fuzzy'
import { idleNudges } from './nudge'
import type { Proposal, Session } from './types'

describe('fuzzy', () => {
  it('matches subsequences, prefers exact and word starts', () => {
    expect(fuzzyScore('ntf', 'Notification popup')).not.toBeNull()
    expect(fuzzyScore('xyz', 'Notification popup')).toBeNull()
    expect(fuzzyScore('pop', 'Notification popup')!).toBeGreaterThan(fuzzyScore('ntf', 'Notification popup')!)
    expect(fuzzyScore('', 'anything')).toBe(0)
    expect(fuzzyScore('notif', 'Selection capsule to be mandatory in form. During user setup')).toBeNull()
    expect(fuzzyScore('npu', 'new pop-up')).not.toBeNull()
  })
  it('ranks best first and keeps order on ties', () => {
    const items = ['#1036 Notification Pop-up', '1036-notification-pop-up', 'Refresh GitHub', 'paywall']
    expect(rank('1036', items, (x) => x)).toEqual(['1036-notification-pop-up', '#1036 Notification Pop-up'])
    expect(rank('', items, (x) => x)).toEqual(items)
  })
})

const s = (p: Partial<Session>): Session => ({ key: 'k', sessionId: 's1', name: 'w', kind: 'background', bgId: 'abcd1234', pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1, issue: 7, ...p })
const prop = (p: Partial<Proposal>): Proposal => ({ id: 1, kind: 'ASSIGN', issue: 7, status: 'sent', summary: '', message: '', note: null, target: {}, ...p })
const NOW = 100 * 60_000

describe('idleNudges', () => {
  it('flags a quiet session working a ticket, and a long wait on a prompt', () => {
    const got = idleNudges([s({}), s({ sessionId: 's2', key: 'k2', name: 'x', state: 'needs-input', issue: null })], [prop({})], { s1: NOW - 30 * 60_000, s2: NOW - 45 * 60_000 }, 20, NOW)
    expect(got.map((n) => [n.session.name, n.kind, n.minutes])).toEqual([['x', 'waiting', 45], ['w', 'idle', 30]])
  })
  it('leaves finished, fresh, working, parked sessions and master alone', () => {
    const quiet = { s1: NOW - 60 * 60_000 }
    expect(idleNudges([s({})], [prop({ status: 'done' })], quiet, 20, NOW)).toEqual([])
    expect(idleNudges([s({})], [prop({})], { s1: NOW - 5 * 60_000 }, 20, NOW)).toEqual([])
    expect(idleNudges([s({ state: 'working' })], [prop({})], quiet, 20, NOW)).toEqual([])
    expect(idleNudges([s({ state: 'suspended' })], [prop({})], quiet, 20, NOW)).toEqual([])
    expect(idleNudges([s({ name: 'master-agent' })], [prop({})], quiet, 20, NOW)).toEqual([])
  })
})
