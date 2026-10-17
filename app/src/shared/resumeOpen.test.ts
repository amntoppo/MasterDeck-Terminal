import { describe, expect, it } from 'vitest'
import { resumedSession, type ResumeTarget } from './resumeOpen'
import type { Session } from './types'

function sess(p: Partial<Session>): Session {
  const id = p.sessionId ?? Math.random().toString(36).slice(2)
  return {
    key: p.key ?? p.bgId ?? id,
    sessionId: id,
    name: 'w',
    kind: 'background',
    bgId: 'abcd1234',
    pid: 42,
    cwd: '/w',
    state: 'idle',
    rawState: 'idle',
    startedAt: 0,
    issue: null,
    ...p,
  }
}

const SID = '11111111-2222-4333-8444-555555555555'
const target: ResumeTarget = { key: '7138e681', sessionId: SID, name: 'fix-login', at: 100_000 }

describe('resumedSession (the session a resume woke)', () => {
  it('by the background id the resume printed', () => {
    const s = sess({ bgId: '7138e681', sessionId: 'other', name: 'renamed' })
    expect(resumedSession([sess({ name: 'fix-login', startedAt: 200_000 }), s], target)).toBe(s)
  })
  it('else by the conversation it resumed (no id printed, or an older Mac answered without one)', () => {
    const s = sess({ bgId: '72a76c62', sessionId: SID })
    expect(resumedSession([s], { ...target, key: null })).toBe(s)
    expect(resumedSession([s], target)).toBe(s)
  })
  it('else by its name, only when it started after the resume was asked', () => {
    const copy = sess({ bgId: '9999aaaa', name: 'fix-login', startedAt: 95_000 })
    expect(resumedSession([copy], { ...target, key: null })).toBe(copy)
    expect(resumedSession([sess({ name: 'fix-login', startedAt: 10_000 })], { ...target, key: null })).toBeNull()
  })
  it('never a stopped row still listed (attaching it would resume it again)', () => {
    expect(resumedSession([sess({ bgId: '7138e681', pid: null, state: 'suspended' })], target)).toBeNull()
    expect(resumedSession([sess({ bgId: '7138e681', pid: null, state: 'done' })], target)).toBeNull()
    const waking = sess({ bgId: '7138e681', pid: null, state: 'working' })
    expect(resumedSession([waking], target)).toBe(waking)
  })
  it('never an interactive session (the same conversation open in another terminal)', () => {
    expect(resumedSession([sess({ kind: 'interactive', bgId: null, sessionId: SID })], target)).toBeNull()
  })
})
