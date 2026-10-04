import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from './appConfig'
import { DEFAULT_SETTINGS } from './settings'
import { fitSnapshot, SNAPSHOT_LIMIT, toRemoteSnapshot, volatileKey } from './remoteSnapshot'
import type { InboxEntry } from './inbox'
import type { AppState, BoardCard, Session } from './types'

function sess(id: string, state: Session['state'], extra: Partial<Session> = {}): Session {
  return { key: id, sessionId: `${id}-sid`, name: id, kind: 'background', bgId: id, pid: null, cwd: '/w', state, rawState: state, startedAt: 5, issue: 7, ...extra }
}
function entry(id: string, kind: InboxEntry['item']['kind'], sessionKey: string | null): InboxEntry {
  return {
    item: { id, kind, priority: 90, sessionKey, ticket: { repo: 'o/r', number: 7 }, title: 't', body: 'b', actions: [{ type: 'reply', label: 'Reply', primary: true }], detail: { type: 'session' } },
    state: 'open', firstSeen: 1, lastSeen: 2,
  }
}
function card(n: number): BoardCard {
  return { number: n, repo: 'o/r', project: 'o/1', title: `card ${n} ${'x'.repeat(200)}`, url: `https://github.com/o/r/issues/${n}`, status: 'Todo', prs: [], assignees: [], labels: [], milestone: null, type: null }
}
function state(over: Partial<AppState> = {}): AppState {
  return {
    sessions: [], proposals: [], issues: [], prs: [], master: { kind: 'absent' }, inbox: { open: [], snoozed: [], history: [] }, stats: {}, tails: { a: { big: 'x'.repeat(1000) } as any }, git: {},
    prLive: {}, sessionPrs: {}, watches: [], schedules: {}, sessionWorktrees: {}, hookInfo: {}, sources: {}, errors: [], lastSnapshotAt: null, statuslineInstalled: false, missingBinaries: [], masterWorkspace: '/', board: null, boardError: null, boardLoading: false, githubRefreshedAt: null, githubRefreshing: false, sprints: [], selectedSprint: '@current', users: [], me: 'amntoppo', settings: DEFAULT_SETTINGS, allStats: {}, costBook: {}, lastActivity: {}, boardHistory: {}, ghCache: null, teamPrs: [], teamPrsAt: null, teamPrsLoading: false, teamPrsError: null, config: DEFAULT_CONFIG, skills: [], hooks: { queue: false, foreignQueue: false, reviewGate: false, masterGuard: false }, stoppedByRestart: [], restoring: false, tokens: {}, pastSessions: {}, asks: {}, menus: {}, prStage: {}, manualStatus: {},
    ...over,
  } as AppState
}

describe('toRemoteSnapshot', () => {
  it('rounds cost to cents and context to whole percent', () => {
    const s = state({ sessions: [sess('a', 'idle')], allStats: { 'a-sid': { costUsd: 1.23456, contextPct: 40.6, updatedAt: 1 } } })
    expect(toRemoteSnapshot(s, 'v').sessions[0]).toMatchObject({ costUsd: 1.23, contextPct: 41 })
  })
  it('volatileKey ignores takenAt, cost and context but not state', () => {
    const mk = (cost: number, ctx: number, st: Session['state'], at: number) =>
      toRemoteSnapshot(state({ sessions: [sess('a', st)], allStats: { 'a-sid': { costUsd: cost, contextPct: ctx, updatedAt: 1 } } }), 'v', at)
    expect(volatileKey(mk(1, 10, 'idle', 1))).toBe(volatileKey(mk(2, 20, 'idle', 2)))
    expect(volatileKey(mk(1, 10, 'idle', 1))).not.toBe(volatileKey(mk(1, 10, 'working', 1)))
  })
  it('volatileKey also ignores monitor counters and schedule nextAt, but not their identity', () => {
    const mk = (events: number, last: number, nextAt: number, desc = 'ci') =>
      toRemoteSnapshot(state({
        sessions: [sess('a', 'idle')],
        schedules: { 'a-sid': [{ id: 'j1', cron: '* * * * *', when: 'Every minute', prompt: 'p', recurring: true, sessionOnly: true, createdAt: 1, nextAt, expiresAt: 2 }] },
        watches: [{ id: 'w1', sessionId: 'a-sid', description: desc, command: 'x', startedAt: 1, events, lastEventAt: last, queued: 0 }],
      }), 'v', 1)
    expect(volatileKey(mk(1, 10, 100))).toBe(volatileKey(mk(5, 50, 200)))
    expect(volatileKey(mk(1, 10, 100))).not.toBe(volatileKey(mk(1, 10, 100, 'other')))
  })
  it('describePending text carries no ticking numbers (labels only)', () => {
    const s = state({ sessions: [sess('a', 'working', { busyWith: 'monitor: ci', waitingOn: 'scheduled: Every 5 minutes' })] })
    const r = toRemoteSnapshot(s, 'v', 1).sessions[0]
    expect(r.busyWith).toBe('monitor: ci')
    expect(r.waitingOn).toBe('scheduled: Every 5 minutes')
  })
  it('keeps live sessions with cost, context, PRs, schedules and monitors', () => {
    const s = state({
      sessions: [sess('a', 'idle', { waitingOn: 'Monitor: ci' }), sess('gone', 'done')],
      allStats: { 'a-sid': { costUsd: 1.5, contextPct: 40, updatedAt: 1 } },
      sessionPrs: { 'a-sid': ['https://github.com/o/r/pull/9'] },
      schedules: { 'a-sid': [{ id: 'j1', cron: '*/5 * * * *', when: 'Every 5 minutes', prompt: 'Check the CI. Then report', recurring: true, sessionOnly: true, createdAt: 1, nextAt: 99, expiresAt: 2 }] },
      watches: [{ id: 'w1', sessionId: 'a-sid', description: 'ci', command: 'x', startedAt: 1, events: 3, lastEventAt: 4, queued: 0 }],
      prLive: { 'https://github.com/o/r/pull/9': { number: 9, title: 'T', url: 'https://github.com/o/r/pull/9', state: 'OPEN', reviewDecision: null, ci: 'pending', reviewCheck: null, buildCi: null, isDraft: false, createdAt: 1 } as any, 'https://github.com/o/r/pull/1': { number: 1 } as any },
    })
    const r = toRemoteSnapshot(s, '0.7.0', 1000)
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0]).toMatchObject({
      key: 'a', sessionId: 'a-sid', waitingOn: 'Monitor: ci', costUsd: 1.5, contextPct: 40,
      prUrls: ['https://github.com/o/r/pull/9'],
      schedules: [{ id: 'j1', name: 'Check the CI', when: 'Every 5 minutes', nextAt: 99 }],
      monitors: [{ id: 'w1', description: 'ci', events: 3, lastEventAt: 4 }],
    })
    expect(Object.keys(r.prLive)).toEqual(['https://github.com/o/r/pull/9'])
    expect(r).toMatchObject({ takenAt: 1000, appVersion: '0.7.0', me: 'amntoppo', master: 'absent' })
    expect(JSON.stringify(r)).not.toContain('"tails"')
  })

  it('sends the inbox with tickets as text, and menus only for open menu items', () => {
    const s = state({
      sessions: [sess('a', 'needs-input'), sess('b', 'needs-input')],
      inbox: { open: [entry('menu:a:1', 'menu', 'a')], snoozed: [], history: [] },
      menus: { a: { tabs: [], question: null, checked: [], review: null }, b: { tabs: [], question: null, checked: [], review: null } } as any,
    })
    const r = toRemoteSnapshot(s, 'v')
    expect(r.inbox.open[0]).toMatchObject({ id: 'menu:a:1', kind: 'menu', ticket: 'o/r#7', state: 'open', actions: [{ type: 'reply', label: 'Reply', primary: true }] })
    expect(Object.keys(r.menus)).toEqual(['a'])
  })

  it('keeps the last 20 history entries', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ ...entry(`h${i}`, 'idle', null), state: 'resolved' as const }))
    expect(toRemoteSnapshot(state({ inbox: { open: [], snoozed: [], history } }), 'v').inbox.history).toHaveLength(20)
  })

  it('maps board cards and keeps open proposals only', () => {
    const s = state({
      board: { takenAt: null, sprint: 'Sprint 9', columns: ['Todo', 'Done'], cards: [{ ...card(1), prs: [{ url: 'https://github.com/o/r/pull/3', repo: 'r', number: 3, state: 'OPEN', ci: null } as any] }] },
      proposals: [
        { id: 1, kind: 'ASSIGN', issue: 7, status: 'proposed', summary: 's', message: '', note: null, target: {} },
        { id: 2, kind: 'ASSIGN', issue: 8, status: 'done', summary: 's', message: '', note: null, target: {} },
      ],
    })
    const r = toRemoteSnapshot(s, 'v')
    expect(r.board).toMatchObject({ sprint: 'Sprint 9', columns: ['Todo', 'Done'] })
    expect(r.board!.cards[0]).toMatchObject({ number: 1, repo: 'o/r', status: 'Todo', prUrls: ['https://github.com/o/r/pull/3'] })
    expect(r.proposals.map((p) => p.id)).toEqual([1])
  })
})

describe('fitSnapshot', () => {
  it('leaves a small snapshot alone', () => {
    const snap = toRemoteSnapshot(state(), 'v')
    const r = fitSnapshot(snap)
    expect(r.trimmed).toEqual([])
    expect(JSON.parse(r.json)).toEqual(snap)
  })

  it('trims history, then cards, then the board, never sessions or the open inbox (Review Focus 5)', () => {
    const cards = Array.from({ length: 5000 }, (_, i) => card(i))
    const s = state({
      sessions: [sess('a', 'idle', { issue: 3, issueRepo: 'o/r' })],
      inbox: { open: [entry('o1', 'question', 'a')], snoozed: [], history: Array.from({ length: 20 }, (_, i) => entry(`h${i}`, 'idle', null)) },
      board: { takenAt: null, sprint: null, columns: ['Todo'], cards },
    })
    const r = fitSnapshot(toRemoteSnapshot(s, 'v'), 200_000)
    expect(r.json.length).toBeLessThanOrEqual(200_000)
    expect(r.trimmed[0]).toBe('history')
    expect(r.snap.sessions).toHaveLength(1)
    expect(r.snap.inbox.open).toHaveLength(1)
    // Cards linked to a session's issue survive the card trim.
    expect(r.snap.board).not.toBeNull()
    expect(r.snap.board!.cards.map((c) => c.number)).toEqual([3])
    expect(r.oversize).toBe(false)
  })

  it('measures bytes, not characters', () => {
    const body = '😀漢'.repeat(100_000) // 300k chars, 700k bytes each; two entries
    const big = toRemoteSnapshot(state({ inbox: { open: [{ ...entry('o1', 'question', null), item: { ...entry('o1', 'question', null).item, body } }, { ...entry('o2', 'question', null), item: { ...entry('o2', 'question', null).item, body } }], snoozed: [], history: [] } }), 'v')
    const json = JSON.stringify(big)
    expect(json.length).toBeLessThan(SNAPSHOT_LIMIT)
    expect(new TextEncoder().encode(json).length).toBeGreaterThan(SNAPSHOT_LIMIT)
    const r = fitSnapshot(big)
    expect(r.trimmed).toContain('bodies')
    expect(new TextEncoder().encode(r.json).length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(r.oversize).toBe(false)
  })

  it('truncates huge inbox bodies as the last step, keeping every entry', () => {
    const e = entry('o1', 'question', null)
    const s = state({ inbox: { open: [{ ...e, item: { ...e.item, body: 'y'.repeat(500_000) } }], snoozed: [{ ...e, item: { ...e.item, id: 's1', body: 'z'.repeat(500_000) } }], history: [] } })
    const r = fitSnapshot(toRemoteSnapshot(s, 'v'))
    expect(r.trimmed.at(-1)).toBe('bodies')
    expect(r.snap.inbox.open).toHaveLength(1)
    expect(r.snap.inbox.open[0].body).toBe('y'.repeat(2000) + '…')
    expect(r.snap.inbox.snoozed[0].body).toHaveLength(2001)
    expect(r.oversize).toBe(false)
  })

  it('reports oversize when nothing droppable is left, with sessions intact', () => {
    const sessions = Array.from({ length: 1000 }, (_, i) => sess(`s${i}`, 'idle', { name: 'n'.repeat(500) }))
    const r = fitSnapshot(toRemoteSnapshot(state({ sessions }), 'v'), 1000)
    expect(r.oversize).toBe(true)
    expect(r.snap.sessions).toHaveLength(1000)
  })

  it('card trim needs the same issue number and repo', () => {
    const cards = [card(3), { ...card(3), repo: 'o/other' }, ...Array.from({ length: 3000 }, (_, i) => card(100 + i))]
    const s = state({ sessions: [sess('a', 'idle', { issue: 3, issueRepo: 'o/r' })], board: { takenAt: null, sprint: null, columns: ['Todo'], cards } })
    const r = fitSnapshot(toRemoteSnapshot(s, 'v'), 100_000)
    expect(r.snap.board!.cards.map((c) => [c.number, c.repo])).toEqual([[3, 'o/r']])
  })

  it('SNAPSHOT_LIMIT is under the 1 MB socket cap', () => {
    expect(SNAPSHOT_LIMIT).toBeLessThan(1_000_000)
  })
})
