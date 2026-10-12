import { useCallback, useSyncExternalStore } from 'react'
import { cleanTabs, closeTab, openTab, pruneSessions, tabId, terminalOnly, type SessionTab, type SessionTabsState } from '@shared/sessionTabs'

/**
 * Every session's tab row (terminal, files, diffs), kept by `Session.key` in localStorage so the
 * tabs stay through a resume, a switch to another session and a restart. One store for the pane's
 * row, Details → Diff / Files, ⌘P and ⌘-click in the terminal: each opens tabs through it.
 */

export interface KeyValue {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

const STORAGE_KEY = 'session-tabs'
const EMPTY = terminalOnly()

export class SessionTabsStore {
  private all: Record<string, SessionTabsState> = {}
  private listeners = new Set<() => void>()

  constructor(private storage: KeyValue | null) {
    let raw: unknown = null
    try {
      raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    } catch {
      raw = null
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) this.all[k] = cleanTabs(v)
  }

  get(key: string): SessionTabsState {
    return this.all[key] ?? EMPTY
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  open(key: string, t: SessionTab): void {
    this.set(key, openTab(this.get(key), t))
  }

  close(key: string, id: string): void {
    this.set(key, closeTab(this.get(key), id))
  }

  activate(key: string, id: string): void {
    const s = this.get(key)
    if (s.active !== id && s.tabs.some((t) => tabId(t) === id)) this.set(key, { ...s, active: id })
  }

  /** Forget the sessions no longer listed. */
  prune(live: Set<string>): void {
    const next = pruneSessions(this.all, live)
    if (Object.keys(next).length === Object.keys(this.all).length) return
    this.all = next
    this.persist()
  }

  private set(key: string, s: SessionTabsState): void {
    if (s === this.get(key)) return
    this.all = { ...this.all, [key]: s }
    this.persist()
    for (const cb of this.listeners) cb()
  }

  private persist(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.all))
    } catch {
      // storage unavailable: the tabs last until the window closes
    }
  }
}

const browserStorage = (): KeyValue | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const sessionTabs = new SessionTabsStore(browserStorage())

/** A session's tab row, re-rendered when it changes. */
export function useSessionTabs(key: string): SessionTabsState {
  const get = useCallback(() => sessionTabs.get(key), [key])
  return useSyncExternalStore(useCallback((cb) => sessionTabs.subscribe(cb), []), get)
}
