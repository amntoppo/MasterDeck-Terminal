import { describe, expect, it } from 'vitest'
import { attentionFor, prStage, sessionStatus } from './review'
import type { PrLive, Proposal, Session } from './types'

const pr = (n: number, o: Partial<PrLive> = {}): PrLive => ({
  number: n,
  title: null,
  url: `u${n}`,
  state: 'OPEN',
  reviewDecision: null,
  ci: null,
  reviewCheck: null,
  buildCi: null,
  isDraft: true,
  createdAt: 0,
  lastCommentAt: null,
  ...o,
})
const MIN = 60_000
const stage = (live: Record<string, PrLive>, now = 5 * MIN) => prStage(Object.keys(live), live, now, 20)

describe('prStage', () => {
  it('Ready for Review when the automated review passed or failed', () => {
    expect(stage({ u1: pr(1, { reviewCheck: 'success' }) })).toMatchObject({ kind: 'ready', why: 'the automated review passed' })
    expect(stage({ u1: pr(1, { reviewCheck: 'failure' }) })).toMatchObject({ kind: 'ready', why: 'the automated review failed' })
  })

  it('Ready for Review when nothing new was said for 20 minutes, even with the review still running', () => {
    expect(stage({ u1: pr(1, { lastCommentAt: 2 * MIN, reviewCheck: 'pending' }) }, 22 * MIN)).toMatchObject({ kind: 'ready', why: 'no new comments for 20 minutes' })
  })

  it('In Review while the review runs or comments are recent', () => {
    expect(stage({ u1: pr(1, { reviewCheck: 'pending' }) })).toMatchObject({ kind: 'in-review', why: 'the automated review is running' })
    expect(stage({ u1: pr(1, { lastCommentAt: 4 * MIN }) }, 10 * MIN)).toMatchObject({ kind: 'in-review' })
  })

  it('every open PR must be reviewed', () => {
    expect(stage({ u1: pr(1, { reviewCheck: 'success' }), u2: pr(2) })?.kind).toBe('in-review')
  })

  it('merged, approved, changes requested and failing CI come first', () => {
    expect(stage({ u1: pr(1, { state: 'MERGED' }), u2: pr(2, { state: 'CLOSED' }) })).toMatchObject({ kind: 'merged', prs: [1] })
    expect(stage({ u1: pr(1, { state: 'MERGED' }), u2: pr(2, { reviewCheck: 'success' }) })?.kind).toBe('ready')
    expect(stage({ u1: pr(1, { reviewDecision: 'APPROVED', buildCi: 'failure' }) })?.kind).toBe('approved')
    expect(stage({ u1: pr(1, { reviewDecision: 'CHANGES_REQUESTED', reviewCheck: 'success' }) })?.kind).toBe('changes')
    expect(stage({ u1: pr(1, { buildCi: 'failure', reviewCheck: 'success' }) })?.kind).toBe('ci-failing')
  })

  it('nothing without PRs, or only closed ones', () => {
    expect(stage({})).toBeNull()
    expect(stage({ u1: pr(1, { state: 'CLOSED' }) })).toBeNull()
  })
})

const S = (state: Session['state'], o: Partial<Session> = {}) => ({ state, name: 'a', issue: 7, ...o }) as Session
const P = (o: Partial<Proposal>): Proposal => ({ id: 1, kind: 'ASSIGN', issue: 7, status: 'sent', summary: '', message: '', note: null, target: { session: 'a' }, ...o })

describe('sessionStatus', () => {
  const ready = { kind: 'ready' as const, prs: [1], why: 'the automated review passed' }
  it('needs input and working win; then question, blocked, the PR, idle', () => {
    expect(sessionStatus(S('needs-input'), ready, P({ status: 'question' })).key).toBe('needs-input')
    expect(sessionStatus(S('working'), ready, null).key).toBe('working')
    expect(sessionStatus(S('idle'), ready, P({ status: 'question', note: 'A or B?' }))).toMatchObject({ key: 'question', why: 'A or B?' })
    expect(sessionStatus(S('idle'), ready, P({ status: 'blocked' })).key).toBe('blocked')
    expect(sessionStatus(S('idle'), ready, null)).toEqual({ key: 'ready', text: 'Ready for Review', why: 'PR #1: the automated review passed' })
    expect(sessionStatus(S('idle'), null, null).text).toBe('Idle')
    expect(sessionStatus(S('done'), ready, null).text).toBe('Ended')
  })
})

describe('attentionFor', () => {
  it('finds the latest question or blocker for the session', () => {
    const list = [P({ id: 1, status: 'question' }), P({ id: 2, status: 'blocked' }), P({ id: 3, status: 'done' }), P({ id: 4, kind: 'CHAT', status: 'question' })]
    expect(attentionFor(S('idle'), list)?.id).toBe(2)
    expect(attentionFor(S('idle', { name: 'b', issue: 9 }), list)).toBeNull()
  })
})
