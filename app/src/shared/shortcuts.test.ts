import { describe, expect, it } from 'vitest'
import { cycle, matchShortcut, showKeys, SHORTCUTS } from './shortcuts'

const key = (k: string, m: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({ key: k, metaKey: !!m.meta, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt })
const mac = { platform: 'darwin', inTextField: false, dialogOpen: false }
const win = { platform: 'win32', inTextField: false, dialogOpen: false }

describe('matchShortcut', () => {
  it('maps Shift+arrows to views and tabs', () => {
    expect(matchShortcut(key('ArrowLeft', { shift: true }), mac)).toEqual({ id: 'view-prev' })
    expect(matchShortcut(key('ArrowRight', { shift: true }), mac)).toEqual({ id: 'view-next' })
    expect(matchShortcut(key('ArrowUp', { shift: true }), mac)).toEqual({ id: 'tab-prev' })
    expect(matchShortcut(key('ArrowDown', { shift: true }), win)).toEqual({ id: 'tab-next' })
  })
  it('leaves Shift+arrows to text fields and dialogs', () => {
    expect(matchShortcut(key('ArrowLeft', { shift: true }), { ...mac, inTextField: true })).toBeNull()
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
