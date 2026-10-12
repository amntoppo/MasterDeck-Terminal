import { insideRoot } from './filePath'

/**
 * A session's own row of tabs: the terminal, always first and never closed, then files and diffs
 * from the session's folder. Kept per `Session.key` (survives a resume) by the renderer.
 */

export type DiffBase = 'uncommitted' | 'branch'

export type SessionTab = { kind: 'terminal' } | { kind: 'file'; path: string } | { kind: 'diff'; path: string; base: DiffBase }

export interface SessionTabsState {
  tabs: SessionTab[]
  active: string
}

export const TERMINAL: SessionTab = { kind: 'terminal' }
export const TERMINAL_ID = 'terminal'
/** File and diff tabs a session keeps; the oldest beyond it are dropped when saved. */
export const MAX_TABS = 40

export const isDiffBase = (v: unknown): v is DiffBase => v === 'uncommitted' || v === 'branch'

export function tabId(t: SessionTab): string {
  return t.kind === 'terminal' ? TERMINAL_ID : t.kind === 'file' ? `file:${t.path}` : `diff:${t.base}:${t.path}`
}

export const terminalOnly = (): SessionTabsState => ({ tabs: [TERMINAL], active: TERMINAL_ID })

/** Focus `t` if it is open, else add it after the active tab and focus it. */
export function openTab(s: SessionTabsState, t: SessionTab): SessionTabsState {
  const id = tabId(t)
  if (s.tabs.some((x) => tabId(x) === id)) return { tabs: s.tabs, active: id }
  const at = Math.max(0, s.tabs.findIndex((x) => tabId(x) === s.active))
  const tabs = [...s.tabs.slice(0, at + 1), t, ...s.tabs.slice(at + 1)]
  return { tabs, active: id }
}

/** Close a file or diff tab; the active one hands over to its right neighbour, else its left. */
export function closeTab(s: SessionTabsState, id: string): SessionTabsState {
  const i = s.tabs.findIndex((x) => tabId(x) === id)
  if (i <= 0 || s.tabs[i].kind === 'terminal') return s
  const tabs = s.tabs.filter((_, j) => j !== i)
  if (s.active !== id) return { tabs, active: s.active }
  const next = tabs[i] ?? tabs[i - 1]
  return { tabs, active: tabId(next) }
}

function cleanTab(v: unknown): SessionTab | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.kind === 'terminal') return TERMINAL
  const path = insideRoot(o.path)
  if (!path) return null
  if (o.kind === 'file') return { kind: 'file', path }
  if (o.kind === 'diff' && isDiffBase(o.base)) return { kind: 'diff', path, base: o.base }
  return null
}

/** A saved state read back: bad entries dropped, the terminal first, at most MAX_TABS others. */
export function cleanTabs(v: unknown): SessionTabsState {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  if (!Array.isArray(o.tabs)) return terminalOnly()
  const seen = new Set<string>([TERMINAL_ID])
  const rest: SessionTab[] = []
  for (const raw of o.tabs) {
    const t = cleanTab(raw)
    if (!t || seen.has(tabId(t))) continue
    seen.add(tabId(t))
    rest.push(t)
  }
  const tabs = [TERMINAL, ...rest.slice(-MAX_TABS)]
  const active = typeof o.active === 'string' && tabs.some((t) => tabId(t) === o.active) ? o.active : TERMINAL_ID
  return { tabs, active }
}

/** Only the sessions still listed. */
export function pruneSessions(store: Record<string, SessionTabsState>, live: Set<string>): Record<string, SessionTabsState> {
  return Object.fromEntries(Object.entries(store).filter(([k]) => live.has(k)))
}
