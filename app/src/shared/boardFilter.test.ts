import { describe, expect, it } from 'vitest'
import { applyFilters, cardAction, composeReviewPrompt, defaultFilters, filterOptions, pickPr, reviewName, UNASSIGNED } from './boardFilter'
import type { Board, BoardCard, BoardPr, Session } from './types'

const card = (p: Partial<BoardCard>): BoardCard => ({ number: 1, title: 'T', url: '', status: 'In Dev', prs: [], assignees: [], labels: [], milestone: null, type: null, ...p })
const pr = (n: number, state: string | null): BoardPr => ({ url: `https://github.com/o/r/pull/${n}`, repo: 'r', number: n, state, ci: null, unresolved: 0 })
const board = (cards: BoardCard[]): Board => ({ takenAt: null, sprint: null, columns: [], cards })
const sess = (p: Partial<Session>): Session => ({ key: 'k', sessionId: 's', name: 'x', kind: 'background', bgId: 'abcd1234', pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1, issue: null, ...p })

const ME = 'alice'
const cards = [
  card({ number: 1, assignees: [ME], labels: ['bug'], milestone: 'Oct', title: 'Notification popup' }),
  card({ number: 2, assignees: ['rahul'], prs: [pr(5, 'OPEN')] }),
  card({ number: 3, assignees: [] }),
  card({ number: 40, assignees: ['rahul', ME], labels: ['mobile'] }),
]

describe('filters', () => {
  it('defaults to my cards', () => {
    expect(applyFilters(board(cards), defaultFilters(ME)).cards.map((c) => c.number)).toEqual([1, 40])
  })
  it('everyone, unassigned, labels, milestone, has-PR, search', () => {
    const f = defaultFilters(null)
    expect(applyFilters(board(cards), f).cards).toHaveLength(4)
    expect(applyFilters(board(cards), { ...f, assignees: [UNASSIGNED] }).cards.map((c) => c.number)).toEqual([3])
    expect(applyFilters(board(cards), { ...f, labels: ['mobile', 'bug'] }).cards.map((c) => c.number)).toEqual([1, 40])
    expect(applyFilters(board(cards), { ...f, milestone: 'Oct' }).cards.map((c) => c.number)).toEqual([1])
    expect(applyFilters(board(cards), { ...f, hasPr: 'with' }).cards.map((c) => c.number)).toEqual([2])
    expect(applyFilters(board(cards), { ...f, search: 'popup' }).cards.map((c) => c.number)).toEqual([1])
    expect(applyFilters(board(cards), { ...f, search: '#4' }).cards.map((c) => c.number)).toEqual([40])
  })
  it('options list me first, then everyone else', () => {
    const o = filterOptions(board(cards), ME, ['zoe'])
    expect(o.assignees).toEqual([ME, 'rahul', 'zoe'])
    expect(o.labels).toEqual(['bug', 'mobile'])
    expect(o.milestones).toEqual(['Oct'])
  })
})

describe('cardAction', () => {
  it('routes by session, owner and PR', () => {
    expect(cardAction(cards[0], ME, [sess({ issue: 1 })])).toBe('session')
    expect(cardAction(cards[0], ME, [])).toBe('start')
    expect(cardAction(cards[1], ME, [])).toBe('pr')
    expect(cardAction(cards[2], ME, [])).toBe('assign')
    expect(cardAction(cards[3], ME, [])).toBe('start')
  })
})

describe('pickPr', () => {
  it('newest open first, else newest; none for no PRs', () => {
    expect(pickPr([pr(3, 'MERGED'), pr(9, 'MERGED'), pr(5, 'OPEN'), pr(4, 'DRAFT')])?.number).toBe(5)
    expect(pickPr([pr(3, 'MERGED'), pr(9, 'CLOSED')])?.number).toBe(9)
    expect(pickPr([])).toBeNull()
  })
})

describe('reviewName', () => {
  it('adds -2, -3 when taken, ignoring ended sessions', () => {
    expect(reviewName('mobile-app', 137, [])).toBe('review-mobile-app-137')
    expect(reviewName('mobile-app', 137, [sess({ name: 'review-mobile-app-137' })])).toBe('review-mobile-app-137-2')
    expect(reviewName('mobile-app', 137, [sess({ name: 'review-mobile-app-137', state: 'done' })])).toBe('review-mobile-app-137')
  })
})

describe('composeReviewPrompt', () => {
  const t = { url: 'https://github.com/acme/mobile-app/pull/137', repo: 'mobile-app', number: 137, title: 'Popup', author: 'rahul', issue: 1036 }
  it('is read-only, posts one COMMENT review, and reports back', () => {
    const p = composeReviewPrompt(t, '')
    expect(p).toContain('Review acme/mobile-app#137 (Popup) by @rahul, for acme/tracker#1036.')
    expect(p).toContain('Do not check out the branch')
    expect(p).toContain('event "COMMENT"')
    expect(p).toContain("'#1036: done — reviewed https://github.com/acme/mobile-app/pull/137'")
    expect(p).not.toContain("the user's review instructions")
  })
  it('appends the instructions', () => {
    expect(composeReviewPrompt(t, 'Focus on the web bell.').endsWith("## The user's review instructions\n\nFocus on the web bell.")).toBe(true)
  })
})
