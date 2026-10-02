import { describe, expect, it } from 'vitest'
import { externalAnswerAllowed, optionMessage, remoteTextAllowed, sendMasterUp, tokenProblem } from './remoteGuard'

describe('optionMessage', () => {
  it('types "KEY: text" for a 1-3 letter or digit key', () => {
    expect(optionMessage('B', 'yes')).toBe('B: yes')
    expect(optionMessage('2', 'go')).toBe('2: go')
    expect(optionMessage('a1', 'x')).toBe('a1: x')
  })
  it('refuses any other key (a shell escape, a slash command, too long, not a string)', () => {
    for (const key of ['!touch /tmp/x;#', '!x', '/x', '/clear', '', 'ABCD', ' B', 'B\x1b', 'é', 1, undefined])
      expect(optionMessage(key, 'yes'), String(key)).toBeNull()
  })
})

describe('remoteTextAllowed', () => {
  it('takes plain text, newlines and tabs inside', () => {
    expect(remoteTextAllowed('B: yes')).toBe(true)
    expect(remoteTextAllowed('a\nb\tc')).toBe(true)
  })
  it('refuses a leading / or ! (after whitespace) and control characters', () => {
    for (const t of ['/clear', '!ls', '  !rm', '\t/compact', '\n!x', 'ok\x1b[A', 'ok\x7f', 'ok\x9b'])
      expect(remoteTextAllowed(t), JSON.stringify(t)).toBe(false)
  })
})

describe('sendMasterUp', () => {
  it('relays through master-agent only for desktop callers with master up', () => {
    expect(sendMasterUp(false, 'attached')).toBe(true)
    expect(sendMasterUp(false, 'elsewhere')).toBe(true)
    expect(sendMasterUp(false, 'absent')).toBe(false)
    expect(sendMasterUp(false, undefined)).toBe(false)
    for (const k of ['attached', 'elsewhere', 'absent', 'duplicate', undefined]) expect(sendMasterUp(true, k), String(k)).toBe(false)
  })
})

describe('externalAnswerAllowed', () => {
  it('free text when allowed, else one of the options', () => {
    expect(externalAnswerAllowed({ options: ['yes', 'no'], allowText: true }, 'maybe')).toBe(true)
    expect(externalAnswerAllowed({ options: ['yes', 'no'], allowText: false }, 'no')).toBe(true)
    expect(externalAnswerAllowed({ options: ['yes', 'no'], allowText: false }, 'maybe')).toBe(false)
    expect(externalAnswerAllowed({ options: [' yes '], allowText: false }, 'yes')).toBe(true)
    expect(externalAnswerAllowed({ allowText: true }, 'anything')).toBe(true)
    expect(externalAnswerAllowed({ allowText: false }, 'anything')).toBe(false)
  })
})

describe('tokenProblem', () => {
  it('takes 32-512 printable ASCII characters', () => {
    expect(tokenProblem('a'.repeat(32))).toBeNull()
    expect(tokenProblem('A~!'.repeat(100))).toBeNull()
    expect(tokenProblem('x'.repeat(512))).toBeNull()
  })
  it('refuses short, long, spaces, control and non-ASCII characters', () => {
    for (const t of ['a'.repeat(31), 'x'.repeat(513), `${'a'.repeat(32)} b`, `${'a'.repeat(32)}\x7f`, `${'a'.repeat(32)}é`, `${'a'.repeat(32)} `])
      expect(tokenProblem(t), JSON.stringify(t)).toBe('a token is 32-512 printable ASCII characters')
  })
})
