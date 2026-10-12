import { describe, expect, it } from 'vitest'
import { cycle, matchShortcut, showKeys, SHORTCUTS } from './shortcuts'

const key = (k: string, m: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({ key: k, metaKey: !!m.meta, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt })
const mac = { platform: 'darwin', inTextField: false, dialogOpen: false }
const win = { platform: 'win32', inTextField: false, dialogOpen: false }

describe('matchShortcut', () => {
  it('maps Shift+Up/Down to tabs and leaves Shift+Left/Right alone', () => {
    expect(matchShortcut(key('ArrowLeft', { shift: true }), mac)).toBeNull()
    expect(matchShortcut(key('ArrowRight', { shift: true }), win)).toBeNull()
    expect(SHORTCUTS.some((s) => s.id.startsWith('view-'))).toBe(false)
    expect(matchShortcut(key('ArrowUp', { shift: true }), mac)).toEqual({ id: 'tab-prev' })
    expect(matchShortcut(key('ArrowDown', { shift: true }), win)).toEqual({ id: 'tab-next' })
  })
  it('leaves Shift+arrows to text fields and dialogs', () => {
    expect(matchShortcut(key('ArrowDown', { shift: true }), { ...mac, inTextField: true })).toBeNull()
    expect(matchShortcut(key('ArrowUp', { shift: true }), { ...mac, dialogOpen: true })).toBeNull()
    expect(matchShortcut(key('ArrowUp'), mac)).toBeNull()
  })
  it('uses ⌘ on macOS and Ctrl elsewhere', () => {
    expect(matchShortcut(key('3', { meta: true }), mac)).toEqual({ id: 'tab-n', n: 3 })
    expect(matchShortcut(key('3', { ctrl: true }), mac)).toBeNull()
    expect(matchShortcut(key('t', { ctrl: true }), win)).toEqual({ id: 'new-shell' })
    expect(matchShortcut(key('W', { meta: true, shift: true }), mac)).toEqual({ id: 'close-tab' })
    expect(matchShortcut(key('M', { meta: true, shift: true }), mac)).toEqual({ id: 'master' })
    expect(matchShortcut(key('F', { meta: true, shift: true }), mac)).toEqual({ id: 'history' })
    expect(matchShortcut(key('f', { meta: true }), mac)).toEqual({ id: 'find' })
  })
  it('opens quick-open with Mod P', () => {
    expect(matchShortcut(key('p', { meta: true }), mac)).toEqual({ id: 'quick-open' })
    expect(matchShortcut(key('p', { ctrl: true }), win)).toEqual({ id: 'quick-open' })
    expect(matchShortcut(key('p', { ctrl: true }), mac)).toBeNull()
    expect(SHORTCUTS.find((s) => s.id === 'quick-open')?.keys).toBe('Mod P')
  })
  it('does not take the default menu combos', () => {
    for (const k of ['r', 'w', 'm', 'h', 'q', '0', 'c', 'v']) expect(matchShortcut(key(k, { meta: true }), mac)).toBeNull()
    expect(matchShortcut(key('R', { meta: true, shift: true }), mac)).toBeNull()
  })
  it('has a matching key for every listed shortcut', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length)
    expect(showKeys('Mod ⇧W', 'darwin')).toBe('⌘⇧W')
    expect(showKeys('Mod K', 'win32')).toBe('Ctrl+K')
  })
})

describe('cycle', () => {
  it('moves and wraps', () => {
    expect(cycle(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(cycle(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(cycle(['a', 'b'], null, 1)).toBe('a')
    expect(cycle([], 'a', 1)).toBeNull()
  })
})
