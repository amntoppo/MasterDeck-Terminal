/**
 * Keyboard shortcuts: one table for the key handler and for the list in Settings. "Mod" is ⌘ on
 * macOS and Ctrl elsewhere. Combos Electron's default menu owns (⌘R, ⌘⇧R, ⌘W, ⌘M, ⌘H, ⌘Q, ⌘0,
 * ⌘+/−, ⌘Z/X/C/V/A) are left alone.
 */

export type ShortcutId =
  | 'view-prev'
  | 'view-next'
  | 'tab-prev'
  | 'tab-next'
  | 'tab-n'
  | 'close-tab'
  | 'new-shell'
  | 'palette'
  | 'needs-you'
  | 'worktree'
  | 'split'
  | 'master'
  | 'refresh'
  | 'settings'
  | 'shortcuts'
  | 'history'

export interface Shortcut {
  id: ShortcutId
  /** Keys as shown: "Mod" becomes ⌘ or Ctrl. */
  keys: string
  what: string
  group: 'Move around' | 'Tabs' | 'Sessions' | 'App'
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'view-prev', keys: '⇧←', what: 'Previous view (Terminals · Board View · PRs · Tasks)', group: 'Move around' },
  { id: 'view-next', keys: '⇧→', what: 'Next view', group: 'Move around' },
  { id: 'needs-you', keys: 'Mod J', what: 'Open the first Needs-you item', group: 'Move around' },
  { id: 'history', keys: 'Mod ⇧F', what: 'History: search every session, jump to the match', group: 'Move around' },
  { id: 'palette', keys: 'Mod K', what: 'Command palette: sessions, tickets, PRs, actions', group: 'Move around' },
  { id: 'tab-prev', keys: '⇧↑', what: 'Previous terminal tab (goes to Terminals)', group: 'Tabs' },
  { id: 'tab-next', keys: '⇧↓', what: 'Next terminal tab', group: 'Tabs' },
  { id: 'tab-n', keys: 'Mod 1–9', what: 'Terminal tab 1–9', group: 'Tabs' },
  { id: 'new-shell', keys: 'Mod T', what: 'New shell in the workspace (+ Shell)', group: 'Tabs' },
  { id: 'close-tab', keys: 'Mod ⇧W', what: 'Close the tab (the session keeps running)', group: 'Tabs' },
  { id: 'split', keys: 'Mod \\', what: 'Show two tabs side by side, or close the split', group: 'Tabs' },
  { id: 'worktree', keys: 'Mod E', what: "The open session's worktrees (open one in your editor)", group: 'Sessions' },
  { id: 'master', keys: 'Mod ⇧M', what: 'Show or hide master (every screen)', group: 'Sessions' },
  { id: 'refresh', keys: 'Mod ⇧G', what: 'Refresh from GitHub', group: 'App' },
  { id: 'settings', keys: 'Mod ,', what: 'Settings', group: 'App' },
  { id: 'shortcuts', keys: 'Mod /', what: 'This list of shortcuts', group: 'App' },
]

export const showKeys = (keys: string, platform: string): string => keys.replace(/Mod ?/g, platform === 'darwin' ? '⌘' : 'Ctrl+')

export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export interface KeyContext {
  platform: string
  /** Focus is in a text field (not a terminal): Shift+arrows select text there. */
  inTextField: boolean
  /** A dialog or popup is open. */
  dialogOpen: boolean
}

/** Which shortcut a key press is, if any ('tab-n' carries its number). */
export function matchShortcut(e: KeyLike, c: KeyContext): { id: ShortcutId; n?: number } | null {
  const mod = c.platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (e.altKey) return null
  if (!mod) {
    if (!e.shiftKey || e.metaKey || e.ctrlKey || c.inTextField || c.dialogOpen) return null
    const arrows: Record<string, ShortcutId> = { ArrowLeft: 'view-prev', ArrowRight: 'view-next', ArrowUp: 'tab-prev', ArrowDown: 'tab-next' }
    return arrows[e.key] ? { id: arrows[e.key] } : null
  }
  const k = e.key.toLowerCase()
  if (!e.shiftKey) {
    if (/^[1-9]$/.test(k)) return { id: 'tab-n', n: Number(k) }
    const plain: Record<string, ShortcutId> = { k: 'palette', t: 'new-shell', j: 'needs-you', e: 'worktree', '\\': 'split', ',': 'settings', '/': 'shortcuts' }
    return plain[k] ? { id: plain[k] } : null
  }
  const shifted: Record<string, ShortcutId> = { w: 'close-tab', m: 'master', g: 'refresh', f: 'history' }
  return shifted[k] ? { id: shifted[k] } : null
}

/** The item `step` places from `current` in `list`, wrapping around. */
export function cycle<T>(list: T[], current: T | null, step: number): T | null {
  if (!list.length) return null
  const i = current === null ? -1 : list.indexOf(current)
  if (i < 0) return step > 0 ? list[0] : list[list.length - 1]
  return list[(i + step + list.length) % list.length]
}
