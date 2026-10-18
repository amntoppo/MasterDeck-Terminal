import { DEFAULT_CONFIG } from './appConfig'
import { DEFAULT_SETTINGS } from './settings'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_COALESCE_MS,
  TYPE_GROUP,
  TYPE_TAG,
  activityRows,
  cleanEvent,
  coalesce,
  diffActivity,
  filterActivity,
  type ActivityEvent,
} from './activityLog'
import type { AppState, BoardCard, GitInfo, Session } from './types'
import type { TeamPr } from './teamPrs'

const NOW = new Date(2026, 9, 18, 15, 0).getTime()
const HOUR = 3_600_000

function sess(key: string, st: Session['state'], extra: Partial<Session> = {}): Session {
  return { key, sessionId: `sid-${key}`, name: key, kind: 'background', bgId: key, pid: null, cwd: '/', state: st, rawState: st, startedAt: 0, issue: null, ...extra }
}
function pr(n: number, extra: Partial<TeamPr> = {}): TeamPr {
  return {
    url: `https://github.com/acme/api/pull/${n}`, repo: 'api', number: n, title: `PR ${n}`, state: 'open', draft: false, author: 'me',
    createdAt: new Date(NOW - 10 * 60_000).toISOString(), updatedAt: '', closedAt: null, mergedAt: null, headRef: 'h', baseRef: 'main',
    additions: 0, deletions: 0, files: 0, reviewDecision: null, labels: [], requested: [], reviews: [], unresolvedThreads: 0, ci: null, issues: [],
    ...extra,
  }
}
function card(n: number, status: string | null, extra: Partial<BoardCard> = {}): BoardCard {
  return { number: n, repo: 'acme/api', project: 'acme/1', title: 'Fix token refresh', url: '', status, prs: [], assignees: [], labels: [], milestone: null, type: null, ...extra }
}
function gitInfo(ahead: number, branch: string | null = 'fix/x', dir = '/w/api'): GitInfo {
  return { dir, branch, ahead, behind: 0, added: 0, removed: 0, files: 0 }
}
function state(p: Partial<AppState> = {}): AppState {
  return {
    sessions: [], proposals: [], issues: [], prs: [], master: { kind: 'absent' }, inbox: { open: [], snoozed: [], history: [] }, stats: {}, tails: {}, git: {},
    prLive: {}, sessionPrs: {}, peers: {}, modLive: {}, held: [], modOff: {}, sessionGroups: { groups: [], of: {} }, modCatalog: [], meetingLive: null, schedRuns: {}, watches: [], prWatches: [], schedules: {}, loops: {}, sessionWorktrees: {}, hookInfo: {}, sources: { agents: 'ok' }, errors: [], lastSnapshotAt: null, statuslineInstalled: false, missingBinaries: [], masterWorkspace: '/', board: null, boardError: null, boardLoading: false, githubRefreshedAt: null, githubRefreshing: false, sprints: [], selectedSprint: '@current', users: [], me: 'me', settings: DEFAULT_SETTINGS, allStats: {}, costBook: {}, lastActivity: {}, boardHistory: {}, ghCache: null, teamPrs: [], teamPrsAt: null, teamPrsLoading: false, teamPrsError: null, config: DEFAULT_CONFIG, skills: [], hooks: { queue: false, foreignQueue: false, reviewGate: false, masterGuard: false }, stoppedByRestart: [], restoring: false, tokens: {}, pastSessions: {}, asks: {}, menus: {}, prStage: {}, manualStatus: {},
    ...p,
  }
}
let n = 0
const ids = () => `id${++n}`
const diff = (a: AppState | null, b: AppState, since?: number) => diffActivity(a, b, NOW, since, ids)
const types = (es: ActivityEvent[]) => es.map((e) => e.type)
const board = (cards: BoardCard[], takenAt: string | null = new Date(NOW - 60_000).toISOString(), sprint: string | null = null) => ({ takenAt, sprint, columns: [], cards, projects: [{ key: 'acme/1', title: 'acme board', columns: [] }] })

describe('diffActivity: sessions', () => {
  it('is silent on first load', () => {
    expect(diff(null, state({ sessions: [sess('a', 'working')] }))).toEqual([])
  })
  it('a new key is session-started, with its subject, target and account', () => {
    const [e, ...rest] = diff(state(), state({ sessions: [sess('a', 'working', { account: 'acme-bot' })] }))
    expect(rest).toEqual([])
    expect(e).toMatchObject({ type: 'session-started', subject: 'session:a', target: { session: 'a' }, account: 'acme-bot', at: NOW })
    expect(e.title).toBe('Session a started')
    expect(e.id).toMatch(/^id\d+$/)
  })
  it('done, suspended or gone is session-ended', () => {
    const prev = state({ sessions: [sess('a', 'idle'), sess('b', 'working'), sess('c', 'idle')] })
    const next = state({ sessions: [sess('a', 'done'), sess('b', 'suspended')] })
    const es = diff(prev, next)
    expect(types(es)).toEqual(['session-ended', 'session-ended', 'session-ended'])
    expect(es.map((e) => e.subject).sort()).toEqual(['session:a', 'session:b', 'session:c'])
  })
  it('a session already done does not end again', () => {
    expect(diff(state({ sessions: [sess('a', 'done')] }), state({ sessions: [sess('a', 'done')] }))).toEqual([])
    expect(diff(state({ sessions: [sess('a', 'done')] }), state())).toEqual([])
  })
  it('a key gone because a copy took its name is not ended', () => {
    const prev = state({ sessions: [sess('a', 'idle', { name: 'api-42' })] })
    const next = state({ sessions: [sess('b', 'working', { name: 'api-42' })] })
    expect(types(diff(prev, next))).toEqual(['session-started'])
  })
  it('working → idle with nothing running is session-finished', () => {
    const es = diff(state({ sessions: [sess('a', 'working')] }), state({ sessions: [sess('a', 'idle')] }))
    expect(es).toHaveLength(1)
    expect(es[0]).toMatchObject({ type: 'session-finished', subject: 'session:a', target: { session: 'a' } })
  })
  it('idle with background work is not finished', () => {
    expect(diff(state({ sessions: [sess('a', 'working')] }), state({ sessions: [sess('a', 'idle', { busyWith: 'an agent' })] }))).toEqual([])
  })
  it('nothing for sessions while the agents source was not healthy', () => {
    const prev = state({ sources: { agents: 'pending' } })
    expect(diff(prev, state({ sessions: [sess('a', 'working')] }))).toEqual([])
    const bad = state({ sources: { agents: 'error' }, sessions: [sess('a', 'working')] })
    expect(diff(bad, state({ sessions: [sess('a', 'idle')] }))).toEqual([])
  })
  it('nothing when the agents source failed in next (the list is not news)', () => {
    const prev = state({ sessions: [sess('a', 'working')] })
    expect(diff(prev, state({ sources: { agents: 'error' } }))).toEqual([])
  })
})

describe('diffActivity: PRs', () => {
  const loaded = (prs: TeamPr[], p: Partial<AppState> = {}) => state({ teamPrs: prs, teamPrsAt: 1, ...p })

  it('a new PR of mine opened within the hour is pr-opened', () => {
    const [e, ...rest] = diff(loaded([]), loaded([pr(5, { account: 'acme-bot' })]))
    expect(rest).toEqual([])
    expect(e).toMatchObject({
      type: 'pr-opened', subject: 'pr:https://github.com/acme/api/pull/5', target: { pr: 'https://github.com/acme/api/pull/5' },
      account: 'acme-bot', repo: 'acme/api', title: 'Opened api#5 PR 5',
    })
  })
  it('mine through a second account, or a session’s PR, counts', () => {
    const other = pr(6, { author: 'acme-two' })
    expect(types(diff(loaded([]), loaded([other], { ghAccounts: [{ login: 'acme-two', primary: false, healthy: true }] })))).toEqual(['pr-opened'])
    const s = sess('a', 'working')
    const p = { sessions: [s], sessionPrs: { [s.sessionId]: [pr(7).url] } }
    expect(types(diff(loaded([], p), loaded([pr(7, { author: 'someone' })], p)))).toEqual(['pr-opened'])
  })
  it('someone else’s PR gives nothing', () => {
    expect(diff(loaded([]), loaded([pr(5, { author: 'someone' })]))).toEqual([])
    const prev = loaded([pr(5, { author: 'someone' })])
    expect(diff(prev, loaded([pr(5, { author: 'someone', mergedAt: 'x', state: 'merged' })]))).toEqual([])
  })
  it('an old PR seen for the first time gives nothing', () => {
    expect(diff(loaded([]), loaded([pr(5, { createdAt: new Date(NOW - 2 * HOUR).toISOString() })]))).toEqual([])
  })
  it('approved, changes requested or a new review is pr-reviewed', () => {
    expect(diff(loaded([pr(5)]), loaded([pr(5, { reviewDecision: 'APPROVED' })]))[0]).toMatchObject({ type: 'pr-reviewed', title: 'api#5 PR 5 was approved' })
    expect(diff(loaded([pr(5)]), loaded([pr(5, { reviewDecision: 'CHANGES_REQUESTED' })]))[0].title).toBe('Changes were requested on api#5 PR 5')
    expect(diff(loaded([pr(5)]), loaded([pr(5, { reviews: [{ login: 'ann', state: 'COMMENTED' }] })]))[0].title).toBe('ann reviewed api#5 PR 5')
    expect(diff(loaded([pr(5)]), loaded([pr(5, { reviewDecision: 'REVIEW_REQUIRED' })]))).toEqual([])
  })
  it('merged and closed', () => {
    expect(diff(loaded([pr(5)]), loaded([pr(5, { mergedAt: 'x', closedAt: 'x', state: 'merged' })]))[0]).toMatchObject({ type: 'pr-merged', title: 'Merged api#5 PR 5' })
    expect(diff(loaded([pr(5)]), loaded([pr(5, { closedAt: 'x', state: 'closed' })]))[0]).toMatchObject({ type: 'pr-closed', title: 'Closed api#5 PR 5' })
  })
  it('nothing for PRs before the first read, or when the next read is missing', () => {
    expect(diff(state({ teamPrs: [] }), loaded([pr(5)]))).toEqual([])
    expect(diff(state({ teamPrs: [pr(5)] }), loaded([pr(5, { mergedAt: 'x' })]))).toEqual([])
    expect(diff(loaded([]), state({ teamPrs: [pr(5)], teamPrsAt: null }))).toEqual([])
  })
  it('an unparsable createdAt is not news', () => {
    expect(diff(loaded([]), loaded([pr(5, { createdAt: 'soon' })]))).toEqual([])
  })
  it('a review from someone who had reviewed already', () => {
    const prev = loaded([pr(5, { reviews: [{ login: 'ann', state: 'COMMENTED' }] })])
    const next = loaded([pr(5, { reviews: [{ login: 'ann', state: 'COMMENTED' }, { login: 'ann', state: 'APPROVED' }] })])
    expect(diff(prev, next)[0].title).toBe('api#5 PR 5 got a review')
  })
  it('a merge or close takes its own time, and one older than an hour is not news', () => {
    const t = NOW - 20 * 60_000
    const iso = new Date(t).toISOString()
    expect(diff(loaded([pr(5)]), loaded([pr(5, { mergedAt: iso, closedAt: iso, state: 'merged' })]))[0]).toMatchObject({ type: 'pr-merged', at: t })
    expect(diff(loaded([pr(5)]), loaded([pr(5, { closedAt: iso, state: 'closed' })]))[0]).toMatchObject({ type: 'pr-closed', at: t })
    const old = new Date(NOW - 2 * HOUR).toISOString()
    expect(diff(loaded([pr(5)]), loaded([pr(5, { mergedAt: old, closedAt: old, state: 'merged' })]))).toEqual([])
    expect(diff(loaded([pr(5)]), loaded([pr(5, { closedAt: old, state: 'closed' })]))).toEqual([])
  })
  it('a PR list read before this process started (the gh cache) is silent', () => {
    const since = NOW - 5 * 60_000
    const prev = state({ teamPrs: [pr(5)], teamPrsAt: since - 1 })
    expect(diff(prev, loaded([pr(5, { mergedAt: 'x', state: 'merged' })], { teamPrsAt: NOW }), since)).toEqual([])
    const fresh = state({ teamPrs: [pr(5)], teamPrsAt: since })
    expect(types(diff(fresh, loaded([pr(5, { mergedAt: 'x', state: 'merged' })], { teamPrsAt: NOW }), since))).toEqual(['pr-merged'])
  })
})

describe('diffActivity: board and git', () => {
  it('a card whose status changed is ticket-moved', () => {
    const [e, ...rest] = diff(state({ board: board([card(42, 'In Dev')]) }), state({ board: board([card(42, 'PR Raised')]) }))
    expect(rest).toEqual([])
    expect(e).toMatchObject({
      type: 'ticket-moved', title: 'api#42 Fix token refresh moved In Dev → PR Raised', detail: 'acme board', repo: 'acme/api',
      subject: 'ticket:acme/api#42', target: { ticket: { repo: 'acme/api', number: 42, project: 'acme/1' } },
    })
  })
  it('derived, new and removed cards, and a board not loaded, give nothing', () => {
    expect(diff(state({ board: board([card(1, 'A', { derived: true })]) }), state({ board: board([card(1, 'B', { derived: true })]) }))).toEqual([])
    expect(diff(state({ board: board([]) }), state({ board: board([card(1, 'A')]) }))).toEqual([])
    expect(diff(state({ board: board([card(1, 'A')]) }), state({ board: board([]) }))).toEqual([])
    expect(diff(state({ board: null }), state({ board: board([card(1, 'A')]) }))).toEqual([])
    expect(diff(state({ board: board([card(1, 'A')]) }), state({ board: null }))).toEqual([])
    // Another board's card with the same number is another card.
    expect(diff(state({ board: board([card(1, 'A')]) }), state({ board: board([card(1, 'B', { project: 'acme/2' })]) }))).toEqual([])
  })
  it('a sprint switch is no move', () => {
    expect(diff(state({ board: board([card(1, 'A')]) }), state({ selectedSprint: 'Sprint 9', board: board([card(1, 'B')]) }))).toEqual([])
    expect(diff(state({ board: board([card(1, 'A')], undefined, 'Sprint 8') }), state({ board: board([card(1, 'B')], undefined, 'Sprint 9') }))).toEqual([])
  })
  it('a board read before this process started, or with no time, is silent', () => {
    const since = NOW - 5 * 60_000
    const next = state({ board: board([card(1, 'B')]) })
    expect(diff(state({ board: board([card(1, 'A')], new Date(since - 1).toISOString()) }), next, since)).toEqual([])
    expect(diff(state({ board: board([card(1, 'A')], null) }), next, since)).toEqual([])
    expect(diff(state({ board: board([card(1, 'A')], 'garbage') }), next, since)).toEqual([])
    expect(types(diff(state({ board: board([card(1, 'A')], new Date(since).toISOString()) }), next, since))).toEqual(['ticket-moved'])
  })
  it('no push without the session list', () => {
    const s = sess('a', 'working')
    const prev = state({ sessions: [s], git: { [s.sessionId]: gitInfo(3) } })
    expect(diff(prev, state({ sources: { agents: 'error' }, sessions: [s], git: { [s.sessionId]: gitInfo(0) } }))).toEqual([])
    expect(types(diff(prev, state({ git: { [s.sessionId]: gitInfo(0) } })))).toEqual(['session-ended'])
  })
  it('ahead going to 0 on the same branch and folder is commit-pushed', () => {
    const s = sess('a', 'working', { account: 'acme-bot' })
    const [e, ...rest] = diff(state({ sessions: [s], git: { [s.sessionId]: gitInfo(3) } }), state({ sessions: [s], git: { [s.sessionId]: gitInfo(0) } }))
    expect(rest).toEqual([])
    expect(e).toMatchObject({ type: 'commit-pushed', title: 'Pushed 3 commits to fix/x', subject: 'push:a:fix/x', target: { session: 'a' }, account: 'acme-bot', detail: 'a' })
    const one = diff(state({ sessions: [s], git: { [s.sessionId]: gitInfo(1) } }), state({ sessions: [s], git: { [s.sessionId]: gitInfo(0) } }))
    expect(one[0].title).toBe('Pushed 1 commit to fix/x')
  })
  it('another branch, another folder or only some pushed gives nothing', () => {
    const s = sess('a', 'working')
    const g = (x: GitInfo) => state({ sessions: [s], git: { [s.sessionId]: x } })
    expect(diff(g(gitInfo(3)), g(gitInfo(0, 'main')))).toEqual([])
    expect(diff(g(gitInfo(3)), g(gitInfo(0, 'fix/x', '/w/other')))).toEqual([])
    expect(diff(g(gitInfo(3)), g(gitInfo(1)))).toEqual([])
    expect(diff(g(gitInfo(3, null)), g(gitInfo(0, null)))).toEqual([])
  })
})

function ev(at: number, extra: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id: `e${at}`, at, type: 'session-finished', title: 't', subject: 'session:a', ...extra }
}

describe('filterActivity', () => {
  const es = [
    ev(3, { type: 'pr-merged', account: 'acme-bot', repo: 'acme/api' }),
    ev(2, { type: 'session-started', account: 'acme-two' }),
    ev(1, { type: 'ticket-moved', account: 'acme-bot', repo: 'acme/web' }),
  ]
  it('an empty filter keeps everything', () => {
    expect(filterActivity(es, {})).toEqual(es)
    expect(filterActivity(es, { groups: [], account: null, repo: null })).toEqual(es)
  })
  it('the conditions combine with AND', () => {
    expect(filterActivity(es, { groups: ['prs', 'tickets'] }).map((e) => e.at)).toEqual([3, 1])
    expect(filterActivity(es, { account: 'acme-bot' }).map((e) => e.at)).toEqual([3, 1])
    expect(filterActivity(es, { groups: ['prs', 'tickets'], account: 'acme-bot', repo: 'acme/web' }).map((e) => e.at)).toEqual([1])
  })
  it('every type has a tag, and a group except release', () => {
    expect(TYPE_TAG['commit-pushed']).toBe('GIT')
    expect(TYPE_GROUP['meeting']).toBe(TYPE_GROUP['note-added'])
    expect(TYPE_GROUP['release']).toBeNull()
  })
})

describe('coalesce', () => {
  it('the same type and subject within 15 minutes replaces the older one, keeping its id', () => {
    const old = ev(NOW - 10 * 60_000, { id: 'keep', title: 'old', detail: 'd1' })
    const other = ev(NOW - 5 * 60_000, { id: 'o', subject: 'session:b' })
    const out = coalesce([other, old], ev(NOW, { id: 'new', title: 'new', detail: 'd2' }))
    expect(out).toEqual([{ ...old, at: NOW, title: 'new', detail: 'd2' }, other])
  })
  it('a different type, subject, or an older one, adds a row, newest first', () => {
    const old = ev(NOW - ACTIVITY_COALESCE_MS - 1)
    expect(coalesce([old], ev(NOW)).map((e) => e.id)).toEqual([`e${NOW}`, old.id])
    expect(coalesce([ev(NOW - 1000)], ev(NOW, { type: 'session-ended' }))).toHaveLength(2)
    expect(coalesce([ev(NOW - 1000)], ev(NOW, { subject: 'session:b' }))).toHaveLength(2)
  })
  it('a detail the newer event lacks goes', () => {
    const out = coalesce([ev(NOW - 1000, { detail: 'd' })], ev(NOW))
    expect(out[0].detail).toBeUndefined()
  })
})

describe('activityRows', () => {
  it('groups by local day with Today, Yesterday and a date', () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime()
    const rows = activityRows([ev(at(18, 14)), ev(at(18, 9)), ev(at(17, 20)), ev(at(13, 8))], NOW)
    expect(rows.map((r) => [r.label, r.events.length])).toEqual([['Today', 2], ['Yesterday', 1], ['Tue 13 Oct', 1]])
    expect(rows[0].key).toBe('2026-10-18')
  })
  it('is empty for no events', () => {
    expect(activityRows([], NOW)).toEqual([])
  })
})

describe('cleanEvent', () => {
  const good = { id: 'x', at: NOW, type: 'pr-merged', title: 'Merged api#5', subject: 'pr:u', target: { pr: 'https://github.com/acme/api/pull/5' }, account: 'acme-bot', repo: 'acme/api' }
  it('keeps a good line', () => {
    expect(cleanEvent(good)).toEqual(good)
  })
  it('refuses a bad type, a missing field or not an object', () => {
    expect(cleanEvent({ ...good, type: 'nope' })).toBeNull()
    expect(cleanEvent({ ...good, at: 'x' })).toBeNull()
    expect(cleanEvent({ ...good, id: '' })).toBeNull()
    expect(cleanEvent({ ...good, subject: undefined })).toBeNull()
    expect(cleanEvent(null)).toBeNull()
    expect(cleanEvent('x')).toBeNull()
  })
  it('cuts strings to 300 characters', () => {
    const e = cleanEvent({ ...good, title: 'a'.repeat(400), detail: 'b'.repeat(400) })!
    expect(e.title).toHaveLength(300)
    expect(e.detail).toHaveLength(300)
  })
  it('checks the target per kind and drops a bad one', () => {
    const t = (target: unknown) => cleanEvent({ ...good, target })?.target
    expect(t({ session: 'a' })).toEqual({ session: 'a' })
    expect(t({ ticket: { repo: 'acme/api', number: 4, project: 'acme/1' } })).toEqual({ ticket: { repo: 'acme/api', number: 4, project: 'acme/1' } })
    expect(t({ schedules: true })).toEqual({ schedules: true })
    expect(t({ note: 'n1' })).toEqual({ note: 'n1' })
    expect(t({ meeting: 'm1' })).toEqual({ meeting: 'm1' })
    expect(t({ pr: 'javascript:alert(1)' })).toBeUndefined()
    expect(t({ ticket: { number: -1 } })).toBeUndefined()
    expect(t({ schedules: 'yes' })).toBeUndefined()
    expect(t({ session: 4 })).toBeUndefined()
    expect(t('x')).toBeUndefined()
  })
  it('drops a bad account or repo', () => {
    const e = cleanEvent({ ...good, account: 5, repo: '' })!
    expect(e.account).toBeUndefined()
    expect(e.repo).toBeUndefined()
  })
})
