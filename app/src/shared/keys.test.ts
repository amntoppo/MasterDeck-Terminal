import { describe, expect, it } from 'vitest'
import { keyOverride, NEWLINE_SEQUENCE } from './keys'

const key = (p: Partial<Parameters<typeof keyOverride>[0]>) => ({
  type: 'keydown',
  key: 'Enter',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...p,
})

describe('keyOverride', () => {
  it('Shift+Enter inserts a new line instead of submitting', () => {
    expect(keyOverride(key({ shiftKey: true }))).toEqual({ send: NEWLINE_SEQUENCE })
    expect(NEWLINE_SEQUENCE).toBe('\x1b\r')
  })
  it('swallows the keypress that follows so no \\r is sent', () => {
    expect(keyOverride(key({ shiftKey: true, type: 'keypress' }))).toBe('swallow')
  })
  it('leaves plain Enter and other chords to xterm', () => {
    expect(keyOverride(key({}))).toBeNull()
    expect(keyOverride(key({ shiftKey: true, metaKey: true }))).toBeNull()
    expect(keyOverride(key({ key: 'a', shiftKey: true }))).toBeNull()
  })
})
