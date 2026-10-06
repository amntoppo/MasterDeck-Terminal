import { describe, expect, it } from 'vitest'
import type { AppState, Session } from '@shared/types'
import { linkable, peerFactsFor, peerRows, pickable } from './peersView'

const sess = (key: string, over: Partial<Session> = {}): Session => ({ key, sessionId: `${key}-sid`, name: key, kind: 'background', bgId: key, pid: 1, cwd: `/w/${key}`, state: 'idle', rawState: 'idle', startedAt: 0, issue: null, ...over })
const state = (over: Partial<AppState>): AppState => ({ sessions: [], peers: {}, stats: {}, ...over } as unknown as AppState)

describe('peersView', () => {
  it('rows show the peers with folder basename and ticket', () => {
    const st = state({ sessions: [sess('a'), sess('b', { issue: 7, issueRepo: 'acme/web', state: 'working' })], peers: { a: ['b'], b: ['a'] } })
    expect(peerRows(st, 'a')).toEqual([{ key: 'b', name: 'b', state: 'working', folder: 'b', ticket: 'web#7' }])
    expect(peerRows(st, 'zz')).toEqual([])
  })
  it('linkable excludes self, done and already linked', () => {
    const st = state({ sessions: [sess('a'), sess('b'), sess('c', { state: 'done' }), sess('d')], peers: { a: ['b'], b: ['a'] } })
    expect(linkable(st, 'a', '').map((s) => s.key)).toEqual(['d'])
  })
  it('pickable offers live sessions not yet chosen', () => {
    const st = state({ sessions: [sess('a'), sess('b'), sess('c', { state: 'done' })] })
    expect(pickable(st, ['a'], '').map((s) => s.key)).toEqual(['b'])
  })
  it('peerFactsFor builds prompt facts from the deck state', () => {
    const st = state({
      sessions: [sess('b', { issue: 7, issueRepo: 'acme/web', state: 'working' })],
      stats: { 'b-sid': { currentDir: '/w/b/sub' } },
      git: { 'b-sid': { branch: 'feat' } },
    } as unknown as Partial<AppState>)
    expect(peerFactsFor(st, ['b', 'gone'])).toEqual([{ key: 'b', name: 'b', cwd: '/w/b/sub', branch: 'feat', ticket: 'web#7', state: 'working', summary: null }])
  })
})
