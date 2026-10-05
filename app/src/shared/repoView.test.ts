import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig, setConfig } from './appConfig'
import { parseBoard, parseCards } from './board'
import {
  applyRead, boardChips, cleanRepos, dumpEntries, liveRepos, loadEntries, needRead, parseRepoIssues, pruneEntries, repoChoices, repoViewBoard, repoViewDeriver,
  repoViewEmpty, repoViewOn, repoViewStatus, repoViewTitle, trimEntries, viewOf, withAssignee, REPO_VIEW_LIVE_MS, REPO_VIEW_MAX_ASK, REPO_VIEW_MAX_CARDS, REPO_VIEW_MAX_ENTRIES, REPO_VIEW_RETRY_MS, REPO_VIEW_STALE_MS, type RepoEntries,
} from './repoView'
import type { DeriveCtx } from './derivedBoard'
import type { BoardCard, RepoView, Session } from './types'

const NOW = Date.parse('2026-09-25T10:00:00Z')
const BOARD = { owner: 'acme', number: 1, title: 'Delivery', columns: ['To Do', 'In QA'] }
const acct = (login: string, owner: string, repos: string[], projects: unknown[], primary = false) => ({
  login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repos[0]?.split('/')[1] ?? '', repos, projects, ...(primary ? { primary: true } : {}),
})
const boarded = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [BOARD] })
const loose = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'] })
const legacy = parseConfig({ owner: 'acme', issueRepo: 'tracker', project: 1 })
const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/tracker', 'acme/api'], [BOARD], true), acct('bob-work', 'globex', ['globex/app'], [])] })
// ticketKey, storedRepo and fullRepo read the global config: acme/tracker is the primary repo.
setConfig(boarded)

const raw = (n: number, repo: string, more: Record<string, unknown> = {}) => ({ number: n, repo, project: null, title: `Issue ${n}`, url: `https://github.com/${repo}/issues/${n}`, status: null, prs: [], assignees: ['alice'], labels: [], milestone: null, type: null, derived: true, state: 'OPEN', closedAt: null, ...more })
const answer = (cards: unknown[], repos: unknown[]) => ({ taken_at: '2026-09-25T10:00:00Z', cards, repos })
const part = (repo: string, more: Record<string, unknown> = {}) => ({ repo, account: null, ok: true, total: 1, shown: 1, ...more })
const sess = (p: Partial<Session> = {}): Session => ({ key: 'k', sessionId: 's', name: 'fix-7', kind: 'background', bgId: 'k', pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1, issue: 7, ...p })
const ctx = (p: Partial<DeriveCtx> = {}): DeriveCtx => ({ sessions: [], past: {}, linkPrs: {}, prLive: {}, now: NOW, ...p })
const read = (cards: unknown[], repos: unknown[]) => parseRepoIssues(answer(cards, repos))!

describe('when a tab is a repository view', () => {
  it('needs picked repositories and an account with a board', () => {
    expect(repoViewOn(null, boarded, ['acme/api'])).toBe(true)
    expect(repoViewOn(null, boarded, [])).toBe(false) // nothing picked: the board, as before
    expect(repoViewOn(null, loose, ['acme/api'])).toBe(false) // no board: the tab already shows the issues, picking filters
    expect(repoViewOn(null, legacy, ['acme/tracker'])).toBe(true) // a config from before `projects`
    expect(repoViewOn('alice', two, ['acme/api'])).toBe(true)
    expect(repoViewOn('bob-work', two, ['globex/app'])).toBe(false)
    expect(repoViewOn(null, parseConfig({}), ['acme/api'])).toBe(false) // before Setup
  })
  it('offers the ticked repositories, with or without cards, then the rest once each', () => {
    expect(repoChoices(null, boarded, [], [])).toEqual(['acme/tracker', 'acme/api'])
    expect(repoChoices(null, legacy, [], [])).toEqual(['acme/tracker']) // one repository is enough to offer the filter
    expect(repoChoices(null, boarded, ['acme/web', 'ACME/API'], ['acme/gone', 'acme/web'])).toEqual(['acme/tracker', 'acme/api', 'acme/web', 'acme/gone'])
    expect(repoChoices('bob-work', two, [], [])).toEqual(['globex/app'])
    expect(repoChoices('alice', two, [], [])).toEqual(['acme/tracker', 'acme/api'])
  })
})

describe('cleanRepos (what an ask may read)', () => {
  it('keeps selected repositories of an account with a board, once, as Setup spells them', () => {
    expect(cleanRepos(['ACME/API', 'acme/api', 'acme/tracker'], boarded)).toEqual(['acme/api', 'acme/tracker'])
    expect(cleanRepos(['acme/secret', 'not a repo', 7, null, '../etc/passwd', 'acme/api; rm -rf'], boarded)).toEqual([])
    expect(cleanRepos('acme/api', boarded)).toEqual([])
    expect(cleanRepos(['acme/api'], loose)).toEqual([]) // no board: `master board` already has these issues
    expect(cleanRepos(['globex/app', 'acme/api'], two)).toEqual(['acme/api'])
    expect(cleanRepos(['acme/api'], parseConfig({}))).toEqual([])
  })
  it('is cut to the most one ask may name', () => {
    const many = parseConfig({ owner: 'acme', issueRepo: 'r0', repos: Array.from({ length: 40 }, (_, i) => `acme/r${i}`), projects: [BOARD] })
    expect(cleanRepos(many.repos, many)).toHaveLength(REPO_VIEW_MAX_ASK)
  })
})

describe('cleanRepos with "Select all" (anyone may ask, so the owner is checked)', () => {
  const all = parseConfig({ owner: 'acme', issueRepo: 'tracker', allRepos: true, projects: [BOARD] })
  const multi = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [{ ...acct('alice', 'acme', ['acme/tracker'], [BOARD], true), allRepos: true }, acct('bob-work', 'globex', ['globex/app'], [])] })
  it('only repositories of an owner the config names', () => {
    expect(cleanRepos(['acme/web', 'ACME/Docs', 'evil/secret', 'globex/app'], all)).toEqual(['acme/web', 'ACME/Docs'])
    expect(cleanRepos(['acme/web', 'globex/app', 'evil/secret'], multi)).toEqual(['acme/web'])
  })
  it('refuses names that are no repository', () => {
    expect(cleanRepos(['-acme/api', 'acme/.', 'acme/..', 'acme/.github', '-/x'], all)).toEqual(['acme/.github'])
    expect(parseRepoIssues(answer([], [part('-acme/api'), part('acme/..'), part('acme/.')]))!.parts).toEqual([])
  })
})

describe('parsing', () => {
  it('reads parts and cards, with the boards that hold an issue', () => {
    const r = read([raw(7, 'acme/api', { onBoards: [{ key: 'acme/1', status: 'In QA' }, { key: 'acme/1' }, { nope: 1 }] }), raw(1, 'acme/tracker'), { junk: true }],
      [part('acme/api', { account: 'alice', total: 40, shown: 2, note: 'Pull request details not read: x' }), part('acme/tracker', { ok: false, note: 'Not found: acme/tracker' }), { repo: 'bad' }, null])
    expect(r.parts).toEqual([
      { repo: 'acme/api', account: 'alice', ok: true, total: 40, shown: 2, note: 'Pull request details not read: x' },
      { repo: 'acme/tracker', account: null, ok: false, total: 1, shown: 1, note: 'Not found: acme/tracker' },
    ])
    expect(r.cards.map((c) => [c.number, c.repo])).toEqual([[7, 'acme/api'], [1, null]]) // the primary repo is kept as null
    expect(r.cards[0].onBoards).toEqual([{ key: 'acme/1', status: 'In QA' }, { key: 'acme/1', status: null }])
    expect(r.cards[1].onBoards).toBeUndefined()
  })
  it('is null for anything that is not an answer', () => {
    for (const bad of [null, 'x', [], {}, { cards: [] }, { repos: [] }, { cards: {}, repos: [] }]) expect(parseRepoIssues(bad)).toBeNull()
  })
  it('a card of `master board` never carries boards, and parseBoard still reads what it read', () => {
    const b = parseBoard({ cards: [{ number: 1, status: 'In Dev', onBoards: [{ key: 'acme/1', status: 'x' }] }], columns: ['In Dev'] })!
    expect(b.cards[0]).not.toHaveProperty('onBoards')
    expect(b.cards[0].status).toBe('In Dev')
    expect(parseCards(JSON.parse(JSON.stringify(read([raw(7, 'acme/api', { onBoards: [{ key: 'acme/1', status: 'In QA' }] })], []).cards)))).toEqual(read([raw(7, 'acme/api', { onBoards: [{ key: 'acme/1', status: 'In QA' }] })], []).cards) // a parsed card parses to itself: what the cache relies on
  })
})

describe('reads', () => {
  const first = applyRead({}, ['acme/api', 'acme/tracker'], read([raw(7, 'acme/api'), raw(8, 'acme/api'), raw(1, 'acme/tracker')], [part('acme/api', { total: 9, shown: 2 }), part('acme/tracker')]), null, NOW)
  it('a good read replaces a repository; its cards are the ones of that repository', () => {
    expect(first['acme/api']).toMatchObject({ repo: 'acme/api', ok: true, total: 9, shown: 2, takenAt: NOW, triedAt: NOW })
    expect(first['acme/api'].cards.map((c) => c.number)).toEqual([7, 8])
    expect(first['acme/tracker'].cards.map((c) => c.number)).toEqual([1])
    const again = applyRead(first, ['acme/api'], read([raw(9, 'acme/api')], [part('acme/api')]), null, NOW + 5)
    expect(again['acme/api'].cards.map((c) => c.number)).toEqual([9])
    expect(again['acme/tracker']).toBe(first['acme/tracker']) // not asked: untouched
  })
  it('a repository the read did not give keeps what was on screen, with the reason', () => {
    const lost = applyRead(first, ['acme/api'], read([], [part('acme/api', { ok: false, note: 'acme/api not read: RATE_LIMITED', total: 0, shown: 0 })]), null, NOW + 5)
    expect(lost['acme/api']).toMatchObject({ ok: false, note: 'acme/api not read: RATE_LIMITED', total: 9, shown: 2, takenAt: NOW, triedAt: NOW + 5 })
    expect(lost['acme/api'].cards.map((c) => c.number)).toEqual([7, 8])
    const failed = applyRead({}, ['acme/api'], null, 'gh: API rate limit exceeded', NOW)
    expect(failed['acme/api']).toMatchObject({ ok: false, note: 'acme/api not read: gh: API rate limit exceeded', takenAt: null, cards: [] })
    expect(applyRead({}, ['acme/api'], read([], []), null, NOW)['acme/api'].note).toBe('acme/api not read: no answer for it')
  })
  it('asks for what was never read or is an hour old, and nothing else', () => {
    expect(needRead({}, ['acme/api'], NOW)).toEqual(['acme/api'])
    expect(needRead(first, ['ACME/API', 'acme/tracker'], NOW + REPO_VIEW_STALE_MS - 1)).toEqual([])
    expect(needRead(first, ['acme/api', 'acme/web'], NOW + REPO_VIEW_STALE_MS)).toEqual(['acme/api', 'acme/web'])
  })
  it('a repository never read is tried again after five minutes, not an hour; a trial from the future counts as none', () => {
    const failed = applyRead({}, ['acme/web'], null, 'offline', NOW)
    expect(needRead(failed, ['acme/web'], NOW + REPO_VIEW_RETRY_MS - 1)).toEqual([])
    expect(needRead(failed, ['acme/web'], NOW + REPO_VIEW_RETRY_MS)).toEqual(['acme/web'])
    expect(needRead(failed, ['acme/web'], NOW - 1)).toEqual(['acme/web']) // triedAt after now: a corrupt cache or a clock set back
    expect(needRead(first, ['acme/api'], NOW - 1)).toEqual(['acme/api'])
    const onceRead = applyRead(first, ['acme/api'], null, 'offline', NOW + 10) // read before: the hour still holds
    expect(needRead(onceRead, ['acme/api'], NOW + 10 + REPO_VIEW_RETRY_MS)).toEqual([])
  })
  it('keeps at most so many repositories, the longest unasked going first, never one in use', () => {
    const many: RepoEntries = {}
    for (let i = 0; i < 5; i++) many[`acme/r${i}`] = { ...first['acme/api'], repo: `acme/r${i}` }
    const asked = Object.fromEntries([1, 2, 3, 4].map((i) => [`acme/r${i}`, { repo: `acme/r${i}`, at: i }])) // r0 never asked: the oldest
    expect(trimEntries(many, asked, new Set(), 5)).toBe(many)
    expect(Object.keys(trimEntries(many, asked, new Set(), 3))).toEqual(['acme/r2', 'acme/r3', 'acme/r4'])
    expect(Object.keys(trimEntries(many, asked, new Set(['acme/r0']), 3))).toEqual(['acme/r0', 'acme/r3', 'acme/r4'])
    expect(REPO_VIEW_MAX_ENTRIES).toBe(30)
  })
  it('a repository stays on screen for an hour after its last ask', () => {
    const asked = { 'acme/api': { repo: 'acme/api', at: NOW }, 'acme/tracker': { repo: 'acme/tracker', at: NOW - REPO_VIEW_LIVE_MS } }
    expect(liveRepos(asked, NOW)).toEqual(['acme/api'])
    expect(liveRepos({}, NOW)).toEqual([])
  })
  it('forgets repositories no longer selected, or whose account has no board any more', () => {
    expect(pruneEntries(first, boarded)).toBe(first)
    expect(Object.keys(pruneEntries(first, parseConfig({ owner: 'acme', issueRepo: 'tracker', projects: [BOARD] })))).toEqual(['acme/tracker'])
    expect(pruneEntries(first, loose)).toEqual({})
  })
  it('the cache holds what was read, and comes back the same', () => {
    const failed = applyRead(first, ['acme/web'], null, 'x', NOW)
    const dumped = JSON.parse(JSON.stringify(dumpEntries(failed)))
    expect(Object.keys(dumped)).toEqual(['acme/api', 'acme/tracker']) // a repository never read is not kept
    expect(loadEntries(dumped)).toEqual(first)
    expect(dumpEntries({})).toBeUndefined()
    for (const bad of [null, 'x', [], { a: 1 }, { a: { repo: 'acme/api' } }, { a: { repo: 'nope', takenAt: 1 } }]) expect(loadEntries(bad)).toEqual({})
    // A cache from before this version has no such key at all.
    expect(loadEntries(undefined)).toEqual({})
  })
  it('an assign shows on the card at once', () => {
    const next = withAssignee(first, { repo: 'acme/api', number: 7 }, 'bob-work')
    expect(next['acme/api'].cards.map((c) => c.assignees)).toEqual([['bob-work'], ['alice']])
    expect(next['acme/tracker']).toBe(first['acme/tracker'])
    expect(withAssignee(first, { repo: 'acme/api', number: 99 }, 'bob-work')).toBe(first)
    expect(withAssignee(first, { repo: null, number: 7 }, 'bob-work')).toBe(first) // #7 of the primary repo is another ticket
  })
})

describe('the view in the state', () => {
  const entries: RepoEntries = applyRead({}, ['acme/api'], read([raw(7, 'acme/api'), raw(8, 'acme/api', { state: 'CLOSED', closedAt: '2026-09-20T08:00:00Z' }), raw(9, 'acme/api', { state: 'CLOSED', closedAt: '2026-08-01T08:00:00Z' })], [part('acme/api')]), null, NOW)
  it('is absent until something was asked for', () => {
    expect(viewOf({}, new Map())).toBeUndefined()
    expect(viewOf({}, new Map([['acme/api', 'acme/api']]))).toEqual({ cards: [], repos: [{ repo: 'acme/api', account: null, ok: false, total: 0, shown: 0, takenAt: null, loading: true }] })
    const v = viewOf(entries, new Map([['acme/api', 'acme/api']]))!
    expect(v.repos).toEqual([{ repo: 'acme/api', account: null, ok: true, total: 1, shown: 1, takenAt: NOW, loading: true }])
    expect(v.cards).toHaveLength(3)
  })
  it('every card gets its column; old closed ones go; nothing changed gives the same object back', () => {
    const derive = repoViewDeriver()
    const v = viewOf(entries, new Map())!
    const a = derive(v, ctx())!
    expect(a.cards.map((c) => [c.number, c.status])).toEqual([[7, 'Todo'], [8, 'Done']])
    expect(a.repos).toBe(v.repos)
    expect(derive(v, ctx({ now: NOW + 5_000 }))).toBe(a)
    const b = derive(v, ctx({ sessions: [sess({ issueRepo: 'acme/api' })] }))!
    expect(b).not.toBe(a)
    expect(b.cards.map((c) => c.status)).toEqual(['In Dev', 'Done']) // a session linked: the card moves at once
    expect(derive(undefined, ctx())).toBeUndefined()
    const empty: RepoView = { cards: [], repos: [] }
    expect(derive(empty, ctx())).toBe(derive(empty, ctx()))
  })
})

describe('the view stays small enough for the web bridge', () => {
  const fat = (n: number, repo: string) => raw(n, repo, { title: `Issue ${n} ${'t'.repeat(110)}`, labels: ['bug', 'backend', 'p1'], assignees: ['alice', 'bob-work'], prs: [{ url: `https://github.com/${repo}/pull/${n}`, owner: 'acme', repo: repo.split('/')[1], number: n, state: 'OPEN', ci: 'success', unresolved: 2 }], onBoards: [{ key: 'acme/1', status: 'In QA' }] })
  const names = Array.from({ length: 10 }, (_, i) => `acme/r${i}`)
  const big = applyRead({}, names, read(names.flatMap((r) => Array.from({ length: 350 }, (_, i) => fat(i + 1, r))), names.map((r) => part(r, { total: 350, shown: 350 }))), null, NOW)
  it('10 repositories of 350 issues: the JSON is far under the frame limit, every repository keeps a share, and says so', () => {
    const v = viewOf(big, new Map())!
    expect(v.cards.length).toBeLessThanOrEqual(REPO_VIEW_MAX_CARDS)
    expect(JSON.stringify(v).length).toBeLessThan(700_000)
    for (const p of v.repos) {
      expect(p).toMatchObject({ total: 350, shown: 350 }) // the counts stay what GitHub said
      expect(p.note).toBe(`Showing the first ${REPO_VIEW_MAX_CARDS / 10} of 350 issues.`)
      expect(v.cards.filter((c) => c.repo === p.repo).length).toBe(REPO_VIEW_MAX_CARDS / 10)
    }
  })
  it('a small repository keeps all its cards; the others share what is left; nothing is cut within budget', () => {
    const mixed: RepoEntries = { ...big, 'acme/r0': { ...big['acme/r0'], cards: big['acme/r0'].cards.slice(0, 10) } }
    const v = viewOf(mixed, new Map(), 100)!
    expect(v.cards.filter((c) => c.repo === 'acme/r0')).toHaveLength(10)
    expect(v.cards).toHaveLength(100)
    expect(v.repos.find((p) => p.repo === 'acme/r0')!.note).toBeUndefined()
    expect(v.repos.find((p) => p.repo === 'acme/r1')!.note).toMatch(/^Showing the first 10 of 350 issues\.$/)
    const whole = viewOf(big, new Map(), 5000)!
    expect(whole.cards).toHaveLength(3500)
    expect(whole.repos.some((p) => p.note)).toBe(false)
    const withNote = viewOf({ 'acme/r1': { ...big['acme/r1'], note: 'Pull request details not read: x' } }, new Map(), 20)!
    expect(withNote.repos[0].note).toBe('Pull request details not read: x Showing the first 20 of 350 issues.')
  })
})

describe('what a tab shows', () => {
  const v: RepoView = {
    cards: parseCards([raw(7, 'acme/api'), raw(1, 'acme/tracker'), raw(3, 'globex/app')]),
    repos: [
      { repo: 'acme/api', account: null, ok: true, total: 412, shown: 300, takenAt: NOW },
      { repo: 'acme/tracker', account: null, ok: false, total: 5, shown: 5, note: 'acme/tracker not read: RATE_LIMITED', takenAt: NOW - 9 },
      { repo: 'acme/web', account: null, ok: false, total: 0, shown: 0, note: 'Not found: acme/web', takenAt: null },
      { repo: 'acme/slow', account: null, ok: false, total: 0, shown: 0, takenAt: null, loading: true },
    ],
  }
  const cfg = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api', 'acme/web', 'acme/slow', 'acme/new'], projects: [BOARD] })
  it('only the picked repositories, in MasterDeck\'s columns, on no board', () => {
    const b = repoViewBoard(v, ['ACME/API', 'acme/tracker'])
    expect(b.cards.map((c: BoardCard) => c.number)).toEqual([7, 1])
    expect(b.projects).toEqual([])
    expect(b.sprint).toBeNull()
    expect(b.columns).toEqual(['Todo', 'In Dev', 'PR Raised', 'Done'])
    expect(repoViewBoard(undefined, ['acme/api']).cards).toEqual([])
  })
  it('says what is loading, what was never read and what the reads left out', () => {
    expect(repoViewStatus(v, ['acme/api'], cfg)).toEqual({ loading: false, failed: [], notes: ['api: showing the first 300 of 412 open issues.'] })
    expect(repoViewStatus(v, ['acme/tracker'], cfg)).toEqual({ loading: false, failed: [], notes: ['acme/tracker not read: RATE_LIMITED'] }) // older cards still show
    expect(repoViewStatus(v, ['acme/web'], cfg)).toEqual({ loading: false, failed: ['acme/web'], notes: ['Not found: acme/web'] })
    expect(repoViewStatus(v, ['acme/slow', 'acme/new'], cfg)).toEqual({ loading: true, failed: [], notes: [] }) // running, and asked a moment ago
    expect(repoViewStatus(undefined, ['acme/api'], cfg).loading).toBe(true)
    // A saved tab naming a repository that was unticked since: never read, and said so (not "loading" for ever).
    expect(repoViewStatus(v, ['acme/gone'], cfg)).toEqual({ loading: false, failed: ['acme/gone'], notes: ['acme/gone is not selected in Setup.'] })
  })
  it('an empty tab says why', () => {
    const st = (p: Partial<ReturnType<typeof repoViewStatus>> = {}) => ({ loading: false, failed: [], notes: [], ...p })
    expect(repoViewEmpty({ cards: 3, shown: 2 }, st())).toBe('cards')
    expect(repoViewEmpty({ cards: 3, shown: 0 }, st({ loading: true }))).toBe('filtered')
    expect(repoViewEmpty({ cards: 0, shown: 0 }, st({ loading: true, failed: ['acme/web'] }))).toBe('loading')
    expect(repoViewEmpty({ cards: 0, shown: 0 }, st({ failed: ['acme/web'] }))).toBe('not-read')
    expect(repoViewEmpty({ cards: 0, shown: 0 }, st())).toBe('no-issues')
  })
  it('names the repositories in the heading', () => {
    expect(repoViewTitle(['acme/api'])).toBe('Issues of api')
    expect(repoViewTitle(['acme/api', 'acme/web', 'acme/tracker'])).toBe('Issues of api, web, tracker')
    expect(repoViewTitle(['acme/api', 'acme/web', 'acme/tracker', 'acme/docs'])).toBe('Issues of api, web and 2 more repositories')
  })
  it('a card on a board shows that board\'s column', () => {
    const [c] = parseCards([raw(7, 'acme/api', { onBoards: [{ key: 'acme/1', status: 'In QA' }, { key: 'acme/9', status: null }] })])
    expect(boardChips(c, boarded)).toEqual([
      { key: 'acme/1', text: 'In QA', title: 'On the Delivery board: In QA' },
      { key: 'acme/9', text: 'No status', title: 'On the acme/9 board: no status' },
    ])
    expect(boardChips(parseCards([raw(8, 'acme/api')])[0], boarded)).toEqual([])
  })
})

describe('the fixture `master repo-issues` answer (tests and the isolated app)', () => {
  it('parses, and its cards land in every column', () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, '../../test/fixtures/repo-issues.json'), 'utf8'))
    const entries = applyRead({}, ['acme/tracker', 'acme/api'], parseRepoIssues(fx), null, NOW)
    const v = repoViewDeriver()(viewOf(entries, new Map()), ctx())!
    expect(v.cards.map((c) => [c.number, c.status])).toEqual([[967, 'Todo'], [2001, 'Todo'], [2002, 'PR Raised'], [31, 'In Dev'], [32, 'Done'], [33, 'Done']])
    expect(v.repos.map((p) => [p.repo, p.ok, p.shown, p.total])).toEqual([['acme/tracker', true, 3, 3], ['acme/api', true, 300, 412]])
    expect(boardChips(v.cards[0], boarded)).toEqual([{ key: 'acme/1', text: 'Dev Done', title: 'On the Delivery board: Dev Done' }])
    // Two weeks on, the closed one has left Done.
    expect(repoViewDeriver()(viewOf(entries, new Map()), ctx({ now: NOW + 14 * 86_400_000 }))!.cards.map((c) => c.number)).not.toContain(33)
  })
})
