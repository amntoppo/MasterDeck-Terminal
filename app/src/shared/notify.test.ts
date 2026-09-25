import { DEFAULT_CONFIG } from './appConfig'
import { DEFAULT_SETTINGS } from './settings'
import { describe, expect, it } from 'vitest'
import { contextAlerts, diffEvents, newlyNeedsInput } from './notify'
import type { AppState, Proposal, Session } from './types'

function sess(id: string, state: Session['state']): Session {
  return { key: id, sessionId: id, name: id, kind: 'background', bgId: id, pid: null, cwd: '/', state, rawState: state, startedAt: 0, issue: null }
}
function prop(id: number, status: string): Proposal {
  return { id, kind: 'ASSIGN', issue: 7, status, summary: 's', message: '', note: 'why', target: {} }
}
function state(sessions: Session[], proposals: Proposal[] = []): AppState {
  return {
    sessions, proposals, issues: [], prs: [], master: { kind: 'absent' }, needsYou: [], stats: {}, tails: {}, git: {},
    prLive: {}, sessionPrs: {}, sources: {}, errors: [], lastSnapshotAt: null, statuslineInstalled: false, missingBinaries: [], masterWorkspace: '/', board: null, boardError: null, boardLoading: false, githubRefreshedAt: null, githubRefreshing: false, sprints: [], selectedSprint: '@current', users: [], me: null, settings: DEFAULT_SETTINGS, allStats: {}, costBook: {}, lastActivity: {}, boardHistory: {}, ghCache: null, teamPrs: [], teamPrsAt: null, teamPrsLoading: false, teamPrsError: null, config: DEFAULT_CONFIG, skills: [], hooks: { ticket: false, pr: false, queue: false }, stoppedByRestart: [], restoring: false,
  }
}

describe('diffEvents', () => {
  it('is silent on first load', () => {
    expect(diffEvents(null, state([sess('a', 'needs-input')], [prop(1, 'proposed')]), null)).toEqual([])
  })
  it('fires when a session starts needing input', () => {
    const e = diffEvents(state([sess('a', 'working')]), state([sess('a', 'needs-input')]), null)
    expect(e).toHaveLength(1)
    expect(e[0].target.sessionKey).toBe('a')
  })
  it('fires working→idle only for unfocused sessions', () => {
    const prev = state([sess('a', 'working')])
    const next = state([sess('a', 'idle')])
    expect(diffEvents(prev, next, null)).toHaveLength(1)
    expect(diffEvents(prev, next, 'a')).toHaveLength(0)
  })
  it('fires once for new proposals and on question/blocked transitions', () => {
    const e = diffEvents(state([], [prop(1, 'sent')]), state([], [prop(1, 'question'), prop(2, 'proposed'), prop(3, 'proposed')]), null)
    expect(e.map((x) => x.title)).toEqual(['2 new proposals', '#7: question'])
  })
  it('context warnings fire once per session, re-arm under 60%, skip ended sessions', () => {
    const warned = new Set<string>()
    const at = (pct: number, st: Session['state'] = 'idle') => ({ ...state([sess('a', st)]), allStats: { a: { costUsd: 1, contextPct: pct, updatedAt: 1 } } })
    expect(contextAlerts(warned, at(86)).map((e) => e.title)).toEqual(['a is at 86% context'])
    expect(contextAlerts(warned, at(84))).toEqual([])
    expect(contextAlerts(warned, at(87))).toEqual([])
    expect(contextAlerts(warned, at(50))).toEqual([])
    expect(contextAlerts(warned, at(90))).toHaveLength(1)
    expect(contextAlerts(new Set(), at(95, 'done'))).toEqual([])
  })
  it('a ticket passing its budget fires once', () => {
    const book = (cost: number) => ({ s: { name: 's', key: 's', issue: 9, days: { '2026-09-25': cost } } })
    const a = { ...state([]), costBook: book(19) }
    const b = { ...state([]), costBook: book(21) }
    expect(diffEvents(a, b, null).map((e) => e.title)).toEqual(['#9 passed its $20 budget'])
    expect(diffEvents(b, { ...b, costBook: book(25) }, null)).toEqual([])
  })
  it('newlyNeedsInput lists sessions that just blocked', () => {
    expect(newlyNeedsInput(state([sess('a', 'working')]), state([sess('a', 'needs-input')]))).toEqual(['a'])
    expect(newlyNeedsInput(null, state([sess('a', 'needs-input')]))).toEqual([])
  })
})
