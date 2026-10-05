import { describe, expect, it } from 'vitest'
import { activeBoardFilterCount, assignChoices, assignSeed, tabFilterUsers, startSessionTitle, reviewRequest, boardForAccount, parseSavedTabs, sprintsForAccount, tabAccount, withAccountTabs, type BoardTab, applyFilters, cardAction, composeReviewPrompt, defaultFilters, filterOptions, normalizeFilters, pickPr, reviewName, UNASSIGNED } from './boardFilter'
import { parseConfig } from './appConfig'
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

describe('a card that is not mine (also in the repository view)', () => {
  it('the Assign popup offers the tab\'s account first, then the people of the card\'s repository by name', () => {
    expect(assignChoices('alice', ['zoe', 'alice', 'Bob'])).toEqual(['alice', 'Bob', 'zoe'])
    expect(assignChoices('bob-work', ['zoe', 'alice'])).toEqual(['bob-work', 'alice', 'zoe']) // another account's tab gets its repository's people too
    expect(assignChoices(null, ['zoe'])).toEqual(['zoe'])
    expect(assignChoices('alice', [])).toEqual(['alice']) // not read yet, or the read failed: me can still be assigned
    expect(assignChoices('Alice', ['zoe', 'ALICE'])).toEqual(['Alice', 'zoe']) // logins compare without case
  })
  it('a card of the primary issue repo starts from the people MasterDeck already has; any other repository is read', () => {
    const one = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'] })
    const st = (users: string[], config = one) => ({ users, config })
    expect(assignSeed(null, st(['zoe', 'bob']))).toEqual(['zoe', 'bob'])
    expect(assignSeed('ACME/Tracker', st(['zoe']))).toEqual(['zoe'])
    expect(assignSeed('acme/api', st(['zoe']))).toBeNull()
    expect(assignSeed(null, st([]))).toBeNull() // nothing read yet: ask
    const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [
      { login: 'alice', primary: true, owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker'], projects: [] },
      { login: 'bob-work', owner: 'globex', issueRepo: 'app', repos: ['globex/app'], projects: [] },
    ] })
    expect(assignSeed('globex/app', st(['zoe'], two))).toBeNull()
    expect(assignSeed(null, st(['zoe'], two))).toEqual(['zoe'])
  })
  it('one account or a legacy config: the popup of a primary-repo card lists exactly who it listed before', () => {
    const legacy = parseConfig({ owner: 'acme', issueRepo: 'tracker', project: 1 })
    const users = ['zoe', 'alice', 'Bob', 'carol']
    expect(assignChoices('alice', assignSeed(null, { users, config: legacy })!)).toEqual(['alice', 'Bob', 'carol', 'zoe'])
  })
  it('the Assignee filter adds the primary repo\'s people only on the primary account\'s tab (or with one account)', () => {
    expect(tabFilterUsers(null, 'alice', ['zoe'])).toEqual(['zoe'])
    expect(tabFilterUsers('alice', 'alice', ['zoe'])).toEqual(['zoe'])
    expect(tabFilterUsers('bob-work', 'alice', ['zoe'])).toEqual([])
    expect(filterOptions({ takenAt: null, sprint: null, columns: [], cards: [{ assignees: ['carol'], labels: [], milestone: null }] } as never, 'bob-work', tabFilterUsers('bob-work', 'alice', ['zoe'])).assignees).toEqual(['bob-work', 'carol'])
  })
  it('Start a session says what stays as it is: who is assigned, and that nothing is written', () => {
    expect(startSessionTitle([])).toBe('Start a session for this issue as it is: nobody is assigned, and nothing is written to GitHub')
    expect(startSessionTitle(['bob-work'])).toBe('Start a session for this issue as it is: it stays assigned to bob-work, and nothing is written to GitHub')
    expect(startSessionTitle(['bob-work', 'zoe'])).toBe('Start a session for this issue as it is: it stays assigned to bob-work, zoe, and nothing is written to GitHub')
  })
  it('a PR review is started for the ticket in its own repository', () => {
    const p = { url: 'https://github.com/acme/api/pull/5', repo: 'api', number: 5, title: 'Fix', author: 'rahul' }
    const r = reviewRequest({ number: 7, repo: 'acme/api' }, p, { sessions: [], cwd: '/w', instructions: 'be kind' })
    expect(r).toMatchObject({ kind: 'PRREVIEW', issue: 7, repo: 'acme/api', name: 'review-api-5', cwd: '/w', proposalId: null, edited: true, approved: false })
    expect(r.prompt).toContain('for acme/api#7')
    // The PR's own repository: main starts the session in its checkout (the folder here is the fallback).
    expect(r.cwdRepo).toBe('acme/api')
    expect(reviewRequest({ number: 7, repo: 'acme/tracker' }, { ...p, url: 'https://github.com/Globex/app/pull/5' }, { sessions: [], cwd: '/w', instructions: '' }).cwdRepo).toBe('Globex/app')
    expect(r.prompt).toContain('be kind')
    // The primary repo's card: no repo in the request, as before.
    expect(reviewRequest({ number: 7, repo: null }, p, { sessions: [], cwd: '/w', instructions: '' }).repo).toBeNull()
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

describe('repos and boards', () => {
  const mixed = [
    card({ number: 1, repo: null, project: 'acme/1', status: 'In Dev' }),
    card({ number: 1, repo: 'acme/api', project: 'acme/2', status: 'Doing' }),
    card({ number: 2, repo: 'acme/web', project: 'acme/2', status: 'Backlog' }),
  ]
  const b: Board = {
    ...board(mixed),
    columns: ['To Do', 'In Dev', 'Backlog', 'Doing'],
    projects: [
      { key: 'acme/1', title: 'Delivery', columns: ['To Do', 'In Dev'] },
      { key: 'acme/2', title: 'Platform', columns: ['Backlog', 'Doing'] },
    ],
  }
  const f = { ...defaultFilters(null) }

  it('filters by repo and by board; empty means all', () => {
    expect(applyFilters(b, f).cards).toHaveLength(3)
    expect(applyFilters(b, { ...f, repos: ['acme/api', 'ACME/web'] }).cards.map((c) => c.repo)).toEqual(['acme/api', 'acme/web'])
    expect(applyFilters(b, { ...f, projects: ['acme/2'] }).cards.map((c) => c.number)).toEqual([1, 2])
  })

  it('a board filter shows only those boards columns', () => {
    expect(applyFilters(b, { ...f, projects: ['acme/2'] }).columns).toEqual(['Backlog', 'Doing'])
    expect(applyFilters(b, f).columns).toEqual(b.columns)
  })

  it('older saved filters get the new fields', () => {
    expect(normalizeFilters({ assignees: ['x'], labels: ['bug'] } as never, 'me')).toMatchObject({ assignees: ['x'], labels: ['bug'], repos: [], projects: [] })
    expect(normalizeFilters(null, 'me').assignees).toEqual(['me'])
  })
})

describe('activeBoardFilterCount', () => {
  it('is 0 for the defaults and counts each changed filter once', () => {
    expect(activeBoardFilterCount(defaultFilters(ME), ME)).toBe(0)
    expect(activeBoardFilterCount(defaultFilters(null), null)).toBe(0)
    expect(activeBoardFilterCount({ ...defaultFilters(ME), assignees: [] }, ME)).toBe(1)
    expect(activeBoardFilterCount({ ...defaultFilters(ME), labels: ['a', 'b'], milestone: 'Oct', hasPr: 'with', search: 'x', hiddenColumns: ['Done'], repos: ['o/r'], projects: ['p'] }, ME)).toBe(7)
  })
})

describe('tabs per account', () => {
  const cfg = parseConfig({ accounts: [
    { login: 'alice', primary: true, owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker'], projects: [{ owner: 'acme', number: 1, columns: ['Todo', 'Done'] }] },
    { login: 'bob-work', owner: 'globex', issueRepo: 'app', repos: ['globex/app'], projects: [{ owner: 'globex', number: 7, columns: ['Backlog', 'Shipped'] }] },
  ] })
  const logins = ['alice', 'bob-work']

  it('a tab saved without an account, or with one no longer connected, is the primary', () => {
    expect(tabAccount({}, logins)).toBeUndefined()
    expect(tabAccount({ account: 'carol' }, logins)).toBeUndefined()
    expect(tabAccount({ account: 'bob-work' }, logins)).toBe('bob-work')
  })
  it('adds a "Mine" tab for each newly connected account, once', () => {
    const tabs: BoardTab[] = [{ id: 'board-mine', name: 'Mine', filters: defaultFilters('alice') }]
    const make = (l: string): BoardTab => ({ id: `board-mine-${l}`, name: 'Mine', account: l, filters: defaultFilters(l) })
    const r = withAccountTabs(tabs, logins, 'alice', [], make)
    expect(r.tabs.map((t) => [t.id, t.account])).toEqual([['board-mine', undefined], ['board-mine-bob-work', 'bob-work']])
    expect(r.added).toEqual(['bob-work'])
    // Closed by the user: not added back.
    const again = withAccountTabs(tabs, logins, 'alice', r.added, make)
    expect(again.tabs).toBe(tabs)
    expect(withAccountTabs(tabs, ['alice'], 'alice', [], make).tabs).toBe(tabs)
  })
  it("shows one account's boards: their cards, their columns, its own Mine", () => {
    const b: Board = {
      ...board([
        card({ number: 1, project: 'acme/1', assignees: ['alice'] }),
        card({ number: 2, project: 'globex/7', assignees: ['bob-work'] }),
        card({ number: 3, repo: 'globex/app', project: null, assignees: [] }),
      ]),
      columns: ['Todo', 'Done', 'Backlog', 'Shipped'],
      projects: [{ key: 'acme/1', title: 'A', columns: ['Todo', 'Done'] }, { key: 'globex/7', title: 'G', columns: ['Backlog', 'Shipped'] }],
    }
    const bob = boardForAccount(b, 'bob-work', cfg)
    expect(bob.cards.map((c) => c.number)).toEqual([2, 3])
    expect(bob.columns).toEqual(['Backlog', 'Shipped'])
    expect(applyFilters(bob, defaultFilters('bob-work')).cards.map((c) => c.number)).toEqual([2])
    expect(boardForAccount(b, 'alice', cfg).cards.map((c) => c.number)).toEqual([1])
    expect(boardForAccount(b, null, cfg)).toBe(b)
    expect(boardForAccount(b, 'alice', parseConfig({ accounts: [{ login: 'alice', owner: 'acme', issueRepo: 'tracker' }] }))).toBe(b)
  })
  it("offers a tab only its account's sprints", () => {
    const sp = (title: string, projects?: string[]) => ({ id: title, title, startDate: '2026-10-01', duration: 14, completed: false, projects })
    const all = [sp('S1', ['acme/1']), sp('S2', ['globex/7']), sp('S3', ['acme/1', 'globex/7']), sp('S4')]
    expect(sprintsForAccount(all, 'bob-work', cfg).map((s) => s.title)).toEqual(['S2', 'S3', 'S4'])
    expect(sprintsForAccount(all, null, cfg)).toBe(all)
    expect(sprintsForAccount(all, 'alice', parseConfig({ accounts: [{ login: 'alice', owner: 'acme', issueRepo: 'tracker' }] }))).toBe(all)
  })
  it('saved tabs: an account is kept, an old tab has none (the primary)', () => {
    const t = parseSavedTabs([{ id: 'a', name: 'Mine', filters: {}, account: 'bob-work' }, { id: 'b', filters: {} }, null], 'alice')
    expect(t?.map((x) => [x.id, x.name, x.account])).toEqual([['a', 'Mine', 'bob-work'], ['b', 'Board', undefined]])
    expect(parseSavedTabs([], 'alice')).toBeNull()
    expect(parseSavedTabs('x', 'alice')).toBeNull()
  })
})
