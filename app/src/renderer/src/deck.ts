import { setConfig } from '@shared/appConfig'
import { useEffect, useState } from 'react'
import type { DeckApi } from '@shared/ipc'
import type { AppState } from '@shared/types'

declare global {
  interface Window {
    deck: DeckApi
  }
}

export const deck = (): DeckApi => window.deck

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)
  useEffect(() => {
    let alive = true
    void deck()
      .getState()
      .then((s) => {
        if (alive && s) {
          setConfig(s.config)
          setState((cur) => cur ?? s)
        }
      })
    const off = deck().onState((s) => {
      setConfig(s.config)
      setState(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

/** Re-render every `ms` so "3m ago" labels move. */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable; nothing to persist
  }
}

export const KIND_COLOR: Record<string, string> = {
  ASSIGN: 'var(--purple)',
  REVIEW: 'var(--accent)',
  CI: 'var(--red)',
  STALE: 'var(--amber)',
  ORPHAN: 'var(--grey)',
  MEETING: '#4fd1c5',
  CHAT: '#9ca3af',
}
