import { describe, expect, it } from 'vitest'
import { mergedPrs, reviewTimer, sessionStatus } from './review'
import type { PrLive } from './types'

const pr = (n: number, o: Partial<PrLive> = {}): PrLive => ({ number: n, title: null, url: `u${n}`, state: 'OPEN', reviewDecision: null, ci: null, isDraft: false, createdAt: 1_000, lastCommentAt: null, ...o })
const MIN = 60_000

describe('reviewTimer', () => {
  it('counts 20 quiet minutes from the PR being created', () => {
    const live = { u1: pr(1) }
    expect(reviewTimer(['u1'], live, 1_000 + 19 * MIN, 20)).toEqual({ prs: [1], since: 1_000, readyAt: 1_000 + 20 * MIN, ready: false })
    expect(reviewTimer(['u1'], live, 1_000 + 20 * MIN, 20)?.ready).toBe(true)
  })

  it('starts again at the latest comment or review, across the open PRs', () => {
    const live = { u1: pr(1, { lastCommentAt: 5 * MIN }), u2: pr(2, { createdAt: 9 * MIN }) }
    expect(reviewTimer(['u1', 'u2'], live, 20 * MIN, 20)).toMatchObject({ prs: [1, 2], since: 9 * MIN, ready: false })
  })

  it('counts drafts; skips merged and closed PRs, and PRs not fetched yet', () => {
    expect(reviewTimer(['u1'], { u1: pr(1, { isDraft: true }) }, 20 * MIN + 1_000, 20)?.ready).toBe(true)
    const live = { u2: pr(2, { state: 'MERGED' }), u3: pr(3, { state: 'CLOSED' }) }
    expect(reviewTimer(['u2', 'u3', 'u4'], live, 99 * MIN, 20)).toBeNull()
    expect(reviewTimer([], live, 0, 20)).toBeNull()
  })
})

describe('mergedPrs', () => {
  it('is the merged PRs once none is open', () => {
    expect(mergedPrs(['u1', 'u2'], { u1: pr(1, { state: 'MERGED' }), u2: pr(2, { state: 'CLOSED' }) })).toEqual([1])
    expect(mergedPrs(['u1', 'u2'], { u1: pr(1, { state: 'MERGED' }), u2: pr(2) })).toBeNull()
    expect(mergedPrs(['u1', 'u2'], { u1: pr(1, { state: 'MERGED' }), u2: pr(2, { isDraft: true }) })).toBeNull()
    expect(mergedPrs(['u1'], { u1: pr(1, { state: 'CLOSED' }) })).toBeNull()
    expect(mergedPrs([], {})).toBeNull()
  })
})

describe('sessionStatus', () => {
  const timer = { prs: [1], since: 0, readyAt: 20 * MIN, ready: false }
  it('says where the PR stands instead of idle', () => {
    expect(sessionStatus('idle', null, [1], 0)).toEqual({ text: 'merged', dot: 'merged', countdown: null })
    expect(sessionStatus('idle', { ...timer, ready: true }, null, 0)).toEqual({ text: 'ready for review', dot: 'review', countdown: null })
    expect(sessionStatus('idle', timer, null, 5 * MIN)).toEqual({ text: 'review in', dot: 'idle', countdown: 15 * MIN })
    expect(sessionStatus('idle', null, null, 0)).toEqual({ text: 'idle', dot: 'idle', countdown: null })
  })

  it('keeps working, needs input and ended as they are', () => {
    expect(sessionStatus('working', { ...timer, ready: true }, null, 0).text).toBe('working')
    expect(sessionStatus('needs-input', null, [1], 0)).toMatchObject({ text: 'needs input', dot: 'needs-input' })
    expect(sessionStatus('done', null, [1], 0).text).toBe('ended')
  })
})
