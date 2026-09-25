import { describe, expect, it } from 'vitest'
import { ownerOf, prOffers } from './offers'
import type { Pr, Proposal, Session } from './types'

const pr = (p: Partial<Pr>): Pr => ({ url: 'https://github.com/acme/mobile-app/pull/137', repo: 'mobile-app', number: 137, title: 't', unresolvedThreads: 0, ci: null, headRef: 'x', refsIssue: 1036, ...p })
const s = (p: Partial<Session>): Session => ({ key: 'k', sessionId: 's1', name: '1036-pop', kind: 'background', bgId: 'abcd1234', pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1, issue: 1036, ...p })
const prop = (p: Partial<Proposal>): Proposal => ({ id: 3, kind: 'CI', issue: 1036, status: 'proposed', summary: 'CI failing on mobile-app#137', message: '', note: null, target: {}, ...p })

describe('prOffers', () => {
  it('offers CI and review work, matched to the owner and master proposal', () => {
    const o = prOffers([pr({ ci: 'failure', unresolvedThreads: 2 })], [s({})], {}, [prop({})], new Set())
    expect(o.map((x) => [x.kind, x.owner?.name, x.proposal?.id])).toEqual([['ci', '1036-pop', 3], ['review', '1036-pop', undefined]])
    expect(o[0].message).toContain('#1036: CI is failing on mobile-app#137')
    expect(o[1].message).toContain('address 2 unresolved review threads')
  })
  it('nothing for a healthy PR; dismissed offers stay hidden until the count changes', () => {
    expect(prOffers([pr({ ci: 'success' })], [], {}, [], new Set())).toEqual([])
    const url = 'https://github.com/acme/mobile-app/pull/137'
    expect(prOffers([pr({ unresolvedThreads: 2 })], [], {}, [], new Set([`review:${url}:2`]))).toEqual([])
    expect(prOffers([pr({ unresolvedThreads: 3 })], [], {}, [], new Set([`review:${url}:2`]))).toHaveLength(1)
  })
  it('ownerOf prefers the session that opened the PR', () => {
    const maker = s({ sessionId: 's2', key: 'k2', name: 'maker', issue: null })
    expect(ownerOf(pr({}), [s({}), maker], { s2: ['https://github.com/acme/mobile-app/pull/137'] })?.name).toBe('maker')
    expect(ownerOf(pr({ refsIssue: null }), [s({})], {})).toBeNull()
  })
})
