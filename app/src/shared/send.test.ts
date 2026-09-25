import { describe, expect, it } from 'vitest'
import { canSend, pasteSequence } from './send'
import type { Session } from './types'

const s = (p: Partial<Session>): Session => ({ key: 'k', sessionId: 's', name: 'w', kind: 'background', bgId: 'abcd1234', pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1, issue: null, ...p })

describe('canSend', () => {
  it('refuses needs-input, ended and parked sessions', () => {
    expect(canSend(s({ state: 'needs-input' }), true, true).ok).toBe(false)
    expect(canSend(s({ state: 'done' }), true, true).ok).toBe(false)
    expect(canSend(s({ state: 'suspended' }), false, true).ok).toBe(false)
  })
  it('uses the open tab, else a hidden attach; working sessions queue the message', () => {
    expect(canSend(s({ state: 'working' }), true, false)).toEqual({ ok: true, via: 'pane' })
    expect(canSend(s({}), false, false)).toEqual({ ok: true, via: 'attach' })
    expect(canSend(s({ state: 'suspended' }), true, false)).toEqual({ ok: true, via: 'pane' })
  })
  it('relays to interactive sessions through master, only when master is up', () => {
    expect(canSend(s({ kind: 'interactive', bgId: null }), false, true)).toEqual({ ok: true, via: 'master' })
    expect(canSend(s({ kind: 'interactive', bgId: null }), false, false).ok).toBe(false)
  })
})

describe('pasteSequence', () => {
  it('wraps text in a bracketed paste and strips nested markers', () => {
    expect(pasteSequence('run tests\r\nthen rebase')).toEqual({ paste: '\x1b[200~run tests\nthen rebase\x1b[201~', enter: '\r' })
    expect(pasteSequence('a\x1b[201~b').paste).toBe('\x1b[200~ab\x1b[201~')
  })
})
