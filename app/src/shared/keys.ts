export interface KeyLike {
  type: string
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/** What Claude Code reads as "insert a new line" (Esc then Enter, as Option+Enter sends). */
export const NEWLINE_SEQUENCE = '\x1b\r'

/**
 * Keys the terminal must handle itself instead of xterm's default.
 * - `{ send }`: write this to the PTY and swallow the key.
 * - `'swallow'`: swallow the event (the matching keypress/keyup of a key already handled).
 * - `null`: let xterm handle it.
 */
export function keyOverride(e: KeyLike): { send: string } | 'swallow' | null {
  // xterm sends a plain \r for Shift+Enter, which submits the prompt.
  if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    return e.type === 'keydown' ? { send: NEWLINE_SEQUENCE } : 'swallow'
  }
  return null
}
