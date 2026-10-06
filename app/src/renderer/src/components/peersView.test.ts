import { describe, expect, it } from 'vitest'
import type { AppState, Session } from '@shared/types'
import { linkable, peerRows } from './peersView'

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
})
