import { describe, expect, it } from 'vitest'
import { resolveSession, suggestSessions } from './link'
import type { Session } from './types'

const s = (p: Partial<Session>): Session => ({
  key: p.sessionId ?? 'k', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'w', kind: 'background', bgId: 'aaaaaaaa',
  pid: 1, cwd: '/w', state: 'idle', rawState: 'idle', startedAt: 1, issue: null, ...p,
})

const A = s({ sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', bgId: 'aaaaaaaa', name: 'Paywall-fix', startedAt: 5 })
const B = s({ sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', bgId: 'bbbbbbbb', name: 'upload', issue: 12, startedAt: 9 })
const M = s({ sessionId: 'cccccccc-1111-2222-3333-444444444444', name: 'master-agent' })

describe('resolveSession', () => {
  it('matches a name (any case), a background id, a full id or an id prefix', () => {
    expect(resolveSession('paywall-FIX', [A, B])).toEqual({ kind: 'session', session: A })
    expect(resolveSession('bbbbbbbb', [A, B])).toEqual({ kind: 'session', session: B })
    expect(resolveSession(' aaaaaaaa-1111-2222-3333-444444444444 ', [A, B])).toEqual({ kind: 'session', session: A })
    expect(resolveSession('aaaaaaaa-11', [A, B])).toEqual({ kind: 'session', session: A })
  })
  it('never offers master, and reports ambiguity', () => {
    expect(resolveSession('master-agent', [A, M]).kind).toBe('none')
    const twin = s({ sessionId: 'dddddddd-1111-2222-3333-444444444444', bgId: 'dddddddd', name: 'paywall-fix' })
    expect(resolveSession('paywall-fix', [A, twin]).kind).toBe('ambiguous')
  })
  it('accepts an unlisted full session id, and nothing else', () => {
    expect(resolveSession('EEEEEEEE-1111-2222-3333-444444444444', [A])).toEqual({ kind: 'id', sessionId: 'eeeeeeee-1111-2222-3333-444444444444' })
    expect(resolveSession('nope', [A])).toEqual({ kind: 'none' })
    expect(resolveSession('', [A])).toEqual({ kind: 'none' })
  })
})

describe('suggestSessions', () => {
  it('filters by text and puts unlinked sessions first', () => {
    expect(suggestSessions('', [B, A, M]).map((x) => x.name)).toEqual(['Paywall-fix', 'upload'])
    expect(suggestSessions('up', [A, B]).map((x) => x.name)).toEqual(['upload'])
  })
})
