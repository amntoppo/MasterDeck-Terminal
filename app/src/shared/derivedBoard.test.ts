import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig, setConfig } from './appConfig'
import { parseBoard } from './board'
import { boardDeriver, boardEmpty, boardless, boardsOf, boardToShow, boardWanted, canMove, columnsWithDerived, unreadRepos, deriveBoard, DERIVED_COLUMNS, derivedNotes, derivedStatus, repoBoardless, tabBoard, withoutDerived, type DeriveCtx } from './derivedBoard'
import type { PastSession } from './pastSessions'
import type { Board, BoardCard, BoardPr, Session } from './types'

const NOW = Date.parse('2026-09-25T10:00:00Z')
const PR = 'https://github.com/acme/tracker/pull/'
const KEY = 'acme/tracker#12'
const BOARD = { owner: 'acme', number: 1, title: 'Delivery', columns: ['To Do', 'In Dev'] }
const acct = (login: string, owner: string, repo: string, projects: unknown[], primary = false) => ({
  login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repo,
  repos: repo ? [`${owner}/${repo}`] : [], projects, ...(primary ? { primary: true } : {}),
})
const one = parseConfig({ owner: 'acme', issueRepo: 'tracker' })
const boarded = parseConfig({ owner: 'acme', issueRepo: 'tracker', projects: [BOARD] })
const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', 'tracker', [BOARD], true), acct('bob-work', 'globex', 'app', []), acct('carol', 'initech', '', [])] })
// ticketKey and storedRepo read the global config: acme/tracker is the primary repo.
setConfig(one)

const pr = (n: number, state: string | null): BoardPr => ({ url: PR + n, repo: 'tracker', number: n, state, ci: null, unresolved: 0 })
const card = (p: Partial<BoardCard> = {}): BoardCard => ({ number: 12, repo: null, project: null, title: 'T', url: '', status: null, prs: [], assignees: [], labels: [], milestone: null, type: null, derived: true, state: 'OPEN', closedAt: null, ...p })
const sess = (p: Partial<Session> = {}): Session => ({ key: 'k', sessionId: 's', name: 'fix-12', kind: 'background', bgId: 'k', pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1, issue: 12, ...p })
const ctx = (p: Partial<DeriveCtx> = {}): DeriveCtx => ({ sessions: [], past: {}, linkPrs: {}, prLive: {}, now: NOW, ...p })
const board = (cards: BoardCard[], p: Partial<Board> = {}): Board => ({ takenAt: null, sprint: null, columns: ['To Do', 'In Dev'], cards, ...p })

describe('derivedStatus', () => {
  it('no session and no PR is Todo, assigned or not', () => {
    expect(derivedStatus(card({ assignees: ['alice'] }), ctx())).toBe('Todo')
    expect(derivedStatus(card(), ctx())).toBe('Todo')
  })
  it('a linked session, live or stopped, is In Dev; a done session, the master or another ticket is not', () => {
    expect(derivedStatus(card(), ctx({ sessions: [sess()] }))).toBe('In Dev')
    expect(derivedStatus(card(), ctx({ sessions: [sess({ issue: 13 }), sess({ key: 'k2', sessionId: 's2' })] }))).toBe('In Dev')
    expect(derivedStatus(card(), ctx({ past: { [KEY]: [{ name: 'fix-12' } as PastSession] } }))).toBe('In Dev')
    expect(derivedStatus(card(), ctx({ sessions: [sess({ state: 'done' })] }))).toBe('Todo')
    expect(derivedStatus(card(), ctx({ sessions: [sess({ name: 'master-agent' })] }))).toBe('Todo')
    expect(derivedStatus(card(), ctx({ sessions: [sess({ issue: 13 })] }))).toBe('Todo')
    expect(derivedStatus(card(), ctx({ sessions: [sess({ issueRepo: 'acme/web' })] }))).toBe('Todo') // #12 of another repo
  })
  it('PR states decide before sessions, in a fixed order', () => {
    const st = (prs: BoardPr[], c: Partial<DeriveCtx> = {}) => derivedStatus(card({ prs }), ctx(c))
    expect(st([pr(1, 'OPEN')])).toBe('PR Raised')
    expect(st([pr(1, 'MERGED'), pr(2, 'OPEN')])).toBe('PR Raised') // merged + open: not done
    expect(st([pr(1, 'DRAFT')])).toBe('In Dev') // a draft is work in progress, session or not
    expect(st([pr(1, 'MERGED'), pr(2, 'DRAFT')])).toBe('In Dev')
    expect(st([pr(1, 'MERGED'), pr(2, 'CLOSED')])).toBe('Done')
    expect(st([pr(1, 'MERGED')], { sessions: [sess()] })).toBe('Done')
    expect(st([pr(1, 'CLOSED')])).toBe('Todo') // closed without merging counts for nothing
    expect(st([pr(1, 'CLOSED')], { sessions: [sess()] })).toBe('In Dev')
    expect(st([pr(1, null)])).toBe('Todo') // a state GitHub did not give
  })
  it('a closed issue is Done whatever else is true', () => {
    expect(derivedStatus(card({ state: 'CLOSED', prs: [pr(1, 'OPEN')] }), ctx({ sessions: [sess()] }))).toBe('Done')
  })
  it('a followed PR is fresher than the card, and PRs MasterDeck recorded for the ticket count', () => {
    expect(derivedStatus(card({ prs: [pr(1, 'OPEN')] }), ctx({ prLive: { [PR + 1]: { state: 'MERGED', isDraft: false } } }))).toBe('Done')
    expect(derivedStatus(card(), ctx({ linkPrs: { [KEY]: [PR + 7] }, prLive: { [PR + 7]: { state: 'OPEN', isDraft: false } } }))).toBe('PR Raised')
    expect(derivedStatus(card(), ctx({ linkPrs: { [KEY]: [PR + 7] }, prLive: { [PR + 7]: { state: 'OPEN', isDraft: true } } }))).toBe('In Dev')
    expect(derivedStatus(card(), ctx({ linkPrs: { [KEY]: [PR + 7] } }))).toBe('Todo') // recorded but not followed: unknown
    expect(derivedStatus(card(), ctx({ linkPrs: { 'acme/tracker#13': [PR + 7] }, prLive: { [PR + 7]: { state: 'OPEN', isDraft: false } } }))).toBe('Todo')
  })
})

describe('deriveBoard', () => {
  it('a board with no derived card is the same object', () => {
    const b = board([card({ derived: undefined, state: undefined, project: 'acme/1', status: 'In Dev' })])
    expect(deriveBoard(b, ctx())).toBe(b)
    expect(deriveBoard(null, ctx())).toBeNull()
    expect(withoutDerived(b)).toBe(b)
  })
  it('sets the columns, leaves board cards alone, and drops issues closed more than 14 days ago', () => {
    const real = card({ number: 1, derived: undefined, state: undefined, project: 'acme/1', status: 'In Dev' })
    const b = board([real, card({ number: 2 }), card({ number: 3, state: 'CLOSED', closedAt: '2026-09-20T08:00:00Z' }), card({ number: 4, state: 'CLOSED', closedAt: '2026-09-01T08:00:00Z' }), card({ number: 5, state: 'CLOSED', closedAt: null })])
    const d = deriveBoard(b, ctx())!
    expect(d.cards.map((c) => [c.number, c.status])).toEqual([[1, 'In Dev'], [2, 'Todo'], [3, 'Done']])
    expect(d.cards[0]).toBe(real)
    expect(b.cards[1].status).toBeNull() // the stored board keeps the facts
    expect(withoutDerived(d).cards.map((c) => c.number)).toEqual([1])
  })
  it('reads what master board prints', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '../../test/fixtures/board-derived.json'), 'utf8'))
    const d = deriveBoard(parseBoard(raw), ctx())!
    expect(d.cards.map((c) => c.status)).toEqual(['Todo', 'PR Raised', 'In Dev', 'Done', 'Done'])
    expect(deriveBoard(parseBoard(raw), ctx({ now: Date.parse('2026-10-20T00:00:00Z') }))!.cards.map((c) => c.number)).toEqual([1, 2, 3, 4])
  })
})

describe('boardless', () => {
  it('one account: the whole config', () => {
    expect(boardless(null, one)).toBe(true)
    expect(boardless(null, boarded)).toBe(false)
    expect(boardless(null, parseConfig({}))).toBe(false) // before Setup there is nothing to show
    expect(boardsOf(null, boarded)).toHaveLength(1)
  })
  it('two or more: each account on its own', () => {
    expect(boardless('alice', two)).toBe(false)
    expect(boardless('bob-work', two)).toBe(true)
    expect(boardless('carol', two)).toBe(false) // no repositories either: nothing to read
    expect(repoBoardless('globex/app', two)).toBe(true)
    expect(repoBoardless('GLOBEX/APP', two)).toBe(true)
    expect(repoBoardless(null, two)).toBe(false) // the primary repo is alice's
    expect(repoBoardless(null, one)).toBe(true)
  })
})

describe('tabBoard', () => {
  const real = card({ number: 1, derived: undefined, state: undefined, project: 'acme/1', status: 'In Dev' })
  const loose = card({ number: 3, repo: 'globex/app', status: 'Todo' })
  it('an account with a board gets its board as before', () => {
    const b = board([real])
    expect(tabBoard(b, null, boarded)).toBe(b)
    expect(tabBoard(null, null, boarded)).toBeNull()
    expect(tabBoard(board([real, loose]), 'alice', two)!.cards.map((c) => c.number)).toEqual([1])
  })
  it('an account without one gets its repository issues in the four columns', () => {
    const t = tabBoard(board([real, loose], { projects: [{ key: 'acme/1', title: 'Delivery', columns: ['To Do', 'In Dev'] }] }), 'bob-work', two)!
    expect(t.cards.map((c) => c.number)).toEqual([3])
    expect(t.columns).toEqual([...DERIVED_COLUMNS])
    expect(t.projects).toEqual([])
    expect(tabBoard(board([card()]), null, one)!.columns).toEqual(['Todo', 'In Dev', 'PR Raised', 'Done'])
  })
})

describe('boardEmpty', () => {
  it('says what is empty', () => {
    expect(boardEmpty({ login: null, total: 3, shown: 2 }, one)).toBe('cards')
    expect(boardEmpty({ login: null, total: 3, shown: 0 }, boarded)).toBe('filtered')
    expect(boardEmpty({ login: null, total: 0, shown: 0 }, boarded)).toBe('filtered') // a board, an empty sprint: as before
    expect(boardEmpty({ login: 'bob-work', total: 3, shown: 0 }, two)).toBe('filtered')
    expect(boardEmpty({ login: 'bob-work', total: 0, shown: 0 }, two)).toBe('no-issues')
    expect(boardEmpty({ login: null, total: 0, shown: 0 }, one)).toBe('no-issues')
    expect(boardEmpty({ login: 'carol', total: 0, shown: 0 }, two)).toBe('nothing-selected')
  })
})

describe('derivedNotes', () => {
  it('notes say what is not shown', () => {
    const part = { account: 'bob-work', repos: ['globex/app'], total: 412, shown: 300, skipped: ['globex/old'], missing: ['globex/gone'] }
    const b = board([], { derived: [{ account: 'alice', repos: [], total: 0, shown: 0, skipped: [], missing: [] }, part] })
    expect(derivedNotes(b, 'bob-work')).toEqual(['Showing the first 300 of 412 open issues.', 'Not read (more than 1 repository): old.', 'Not found: globex/gone'])
    expect(derivedNotes(b, 'alice')).toEqual([])
    expect(derivedNotes(board([], { derived: [{ ...part, account: null, total: 300, skipped: [], missing: [] }] }), null)).toEqual([])
    expect(derivedNotes(board([]), null)).toEqual([])
    expect(derivedNotes(null, null)).toEqual([])
  })
})

describe('what the read says went wrong', () => {
  const part = { account: 'bob-work', repos: ['globex/app', 'globex/api', 'globex/gone'], total: 3, shown: 3, skipped: [], missing: ['globex/api', 'globex/gone'] }
  it('a repository GitHub could not read says why; one GitHub does not know is not found', () => {
    const b = board([], { derived: [{ ...part, notes: ['globex/api not read: RATE_LIMITED', 'Pull request details not read: HTTP 401'] }] })
    expect(derivedNotes(b, 'bob-work')).toEqual(['Not found: globex/gone', 'globex/api not read: RATE_LIMITED', 'Pull request details not read: HTTP 401'])
  })
  it('another account\'s notes stay in its own tab', () => {
    const b = board([], { derived: [{ ...part, notes: ['globex/api not read: RATE_LIMITED'] }, { ...part, account: 'carol', missing: [] }] })
    expect(derivedNotes(b, 'carol')).toEqual([])
  })
})

describe('boardWanted', () => {
  it('nothing to read when no board and no repository is selected', () => {
    expect(boardWanted(one)).toBe(true) // repositories only: their issues
    expect(boardWanted(boarded)).toBe(true)
    expect(boardWanted(two)).toBe(true)
    expect(boardWanted(parseConfig({}))).toBe(false) // before Setup
    expect(boardWanted(parseConfig({ configured: true, config: {} }))).toBe(false) // set up, nothing ticked
    expect(boardWanted(parseConfig({ configured: true, config: { accounts: [acct('alice', 'acme', '', [], true), acct('carol', 'initech', '', [])] } }))).toBe(false)
  })
})

describe('boardDeriver', () => {
  const real = card({ number: 1, derived: undefined, state: undefined, project: 'acme/1', status: 'In Dev' })
  it('gives the same board back while nothing changed', () => {
    const derive = boardDeriver()
    const b = board([real, card({ number: 2 })])
    const first = derive(b, ctx())
    expect(first!.cards.map((c) => c.status)).toEqual(['In Dev', 'Todo'])
    expect(derive(b, ctx({ now: NOW + 3000 }))).toBe(first)
  })
  it('a new board when a card changes column, leaves, or the read is new', () => {
    const derive = boardDeriver()
    const b = board([card({ number: 12 }), card({ number: 3, state: 'CLOSED', closedAt: '2026-09-20T08:00:00Z' })])
    const first = derive(b, ctx())!
    const linked = derive(b, ctx({ sessions: [sess()] }))!
    expect(linked).not.toBe(first)
    expect(linked.cards[0].status).toBe('In Dev')
    expect(derive(b, ctx({ sessions: [sess()] }))).toBe(linked)
    const later = derive(b, ctx({ sessions: [sess()], now: Date.parse('2026-10-20T00:00:00Z') }))!
    expect(later.cards.map((c) => c.number)).toEqual([12]) // closed more than 14 days ago now
    const again = board([...b.cards])
    expect(derive(again, ctx({ sessions: [sess()] }))).not.toBe(linked)
  })
  it('sees a card changed in place (an assign shows at once)', () => {
    const derive = boardDeriver()
    const b = board([card({ number: 2 })])
    const first = derive(b, ctx())!
    b.cards[0].assignees = ['alice']
    const next = derive(b, ctx())!
    expect(next).not.toBe(first)
    expect(next.cards[0].assignees).toEqual(['alice'])
  })
  it('a board with no derived card stays the same object', () => {
    const derive = boardDeriver()
    const b = board([real])
    expect(derive(b, ctx())).toBe(b)
    expect(derive(null, ctx())).toBeNull()
  })
})

describe('columnsWithDerived', () => {
  const real = card({ number: 1, derived: undefined, state: undefined, project: 'acme/1', status: 'In Dev' })
  it('a board with no derived card keeps its columns (the same array)', () => {
    const b = board([real])
    expect(columnsWithDerived(b)).toBe(b.columns)
  })
  it('adds MasterDeck\'s columns after the board\'s; alone when every card is derived', () => {
    expect(columnsWithDerived(board([real, card({ status: 'Todo' })]))).toEqual(['To Do', 'In Dev', 'Todo', 'PR Raised', 'Done'])
    expect(columnsWithDerived(board([card({ status: 'Todo' })]))).toEqual(['Todo', 'In Dev', 'PR Raised', 'Done'])
  })
})

describe('a tab whose repositories were not read', () => {
  const part = { account: 'bob-work', repos: ['globex/app'], total: 0, shown: 0, skipped: [], missing: [] as string[] }
  it('names the repositories the read did not get', () => {
    expect(unreadRepos(board([], { derived: [part] }), 'bob-work', two)).toBeNull() // read, and empty
    expect(unreadRepos(board([], { derived: [{ ...part, missing: ['globex/app'] }] }), 'bob-work', two)).toEqual(['globex/app']) // renamed or deleted
    expect(unreadRepos(board([], { derived: [{ ...part, missing: ['globex/app'], notes: ['globex/app not read: RATE_LIMITED'] }] }), 'bob-work', two)).toEqual(['globex/app'])
    expect(unreadRepos(board([], { derived: [{ ...part, notes: ['Pull request details not read: HTTP 401'] }] }), 'bob-work', two)).toEqual(['globex/app'])
    expect(unreadRepos(board([], { derived: [{ ...part, account: 'alice', missing: ['x/y'] }] }), 'bob-work', two)).toEqual(['globex/app']) // no read of this account at all
    expect(unreadRepos(board([]), null, one)).toEqual(['acme/tracker'])
    expect(unreadRepos(board([]), null, boarded)).toBeNull() // a board: not this read
    expect(unreadRepos(null, 'bob-work', two)).toBeNull() // nothing loaded yet
  })
  it('each empty state', () => {
    expect(boardEmpty({ login: 'carol', total: 0, shown: 0, unread: null }, two)).toBe('nothing-selected')
    expect(boardEmpty({ login: 'bob-work', total: 0, shown: 0, unread: ['globex/app'] }, two)).toBe('not-read')
    expect(boardEmpty({ login: 'bob-work', total: 0, shown: 0, unread: null }, two)).toBe('no-issues')
    expect(boardEmpty({ login: 'bob-work', total: 3, shown: 0, unread: ['globex/api'] }, two)).toBe('filtered') // some were read: the filters hide them
    expect(boardEmpty({ login: 'bob-work', total: 3, shown: 2, unread: ['globex/api'] }, two)).toBe('cards')
    expect(boardEmpty({ login: null, total: 0, shown: 0, unread: ['x/y'] }, boarded)).toBe('filtered') // a board: as before
  })
})

describe('boardToShow', () => {
  it('no board on screen once nothing is selected', () => {
    const b = board([card()])
    expect(boardToShow(b, one)).toBe(b)
    expect(boardToShow(b, boarded)).toBe(b)
    expect(boardToShow(b, parseConfig({ configured: true, config: {} }))).toBeNull() // every repository and board unticked: the cached one goes
    expect(boardToShow(b, parseConfig({}))).toBeNull()
    expect(boardToShow(null, one)).toBeNull()
  })
})

describe('canMove', () => {
  const real = card({ derived: undefined, state: undefined, project: 'acme/1', status: 'In Dev' })
  it('only a card of a real board, in a tab with a board', () => {
    expect(canMove(real, false)).toBe(true)
    expect(canMove(card(), false)).toBe(false) // an issue of an account with no board: no status on GitHub
    expect(canMove(card(), true)).toBe(false)
    expect(canMove(real, true)).toBe(false)
    expect(canMove(undefined, false)).toBe(false)
  })
})
