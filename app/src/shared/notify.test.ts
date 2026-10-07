import { DEFAULT_CONFIG } from './appConfig'
import { DEFAULT_SETTINGS } from './settings'
import { describe, expect, it } from 'vitest'
import { diffEvents, newlyNeedsInput } from './notify'
import type { AppState, Proposal, Session } from './types'

function sess(id: string, state: Session['state']): Session {
  return { key: id, sessionId: id, name: id, kind: 'background', bgId: id, pid: null, cwd: '/', state, rawState: state, startedAt: 0, issue: null }
}
function prop(id: number, status: string): Proposal {
  return { id, kind: 'ASSIGN', issue: 7, status, summary: 's', message: '', note: 'why', target: {} }
}
function state(sessions: Session[], proposals: Proposal[] = []): AppState {
  return {
    sessions, proposals, issues: [], prs: [], master: { kind: 'absent' }, inbox: { open: [], snoozed: [], history: [] }, stats: {}, tails: {}, git: {},
    prLive: {}, sessionPrs: {}, peers: {}, watches: [], schedules: {}, sessionWorktrees: {}, hookInfo: {}, sources: {}, errors: [], lastSnapshotAt: null, statuslineInstalled: false, missingBinaries: [], masterWorkspace: '/', board: null, boardError: null, boardLoading: false, githubRefreshedAt: null, githubRefreshing: false, sprints: [], selectedSprint: '@current', users: [], me: null, settings: DEFAULT_SETTINGS, allStats: {}, costBook: {}, lastActivity: {}, boardHistory: {}, ghCache: null, teamPrs: [], teamPrsAt: null, teamPrsLoading: false, teamPrsError: null, config: DEFAULT_CONFIG, skills: [], hooks: { queue: false, foreignQueue: false, reviewGate: false, masterGuard: false }, stoppedByRestart: [], restoring: false, tokens: {}, pastSessions: {}, asks: {}, menus: {}, prStage: {}, manualStatus: {},
  }
}

describe('diffEvents', () => {
  it('is silent on first load', () => {
    expect(diffEvents(null, state([sess('a', 'needs-input')], [prop(1, 'proposed')]), null)).toEqual([])
  })
  it('fires working→idle only for unfocused sessions', () => {
    const prev = state([sess('a', 'working')])
    const next = state([sess('a', 'idle')])
    expect(diffEvents(prev, next, null)).toHaveLength(1)
    expect(diffEvents(prev, next, 'a')).toHaveLength(0)
  })
  it('newlyNeedsInput lists sessions that just blocked', () => {
    expect(newlyNeedsInput(state([sess('a', 'working')]), state([sess('a', 'needs-input')]))).toEqual(['a'])
    expect(newlyNeedsInput(null, state([sess('a', 'needs-input')]))).toEqual([])
  })
})
