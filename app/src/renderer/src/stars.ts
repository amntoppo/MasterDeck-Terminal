import { useSyncExternalStore } from 'react'
import { toggleStar as toggled } from '@shared/stars'
import { load, save } from './deck'

/**
 * The starred sessions (Session.key), kept in localStorage like the sidebar order so they survive a
 * restart. One store, so the sidebar row, its menu and the Details panel always agree.
 */
const KEY = 'starredSessions'
let stars: string[] = load<string[]>(KEY, [])
const listeners = new Set<() => void>()

function set(next: string[]): void {
  if (next === stars) return
  stars = next
  save(KEY, stars)
  for (const l of listeners) l()
}

export function useStars(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => stars,
  )
}

export function toggleStar(key: string): void {
  set(toggled(stars, key))
}

export function setStars(next: string[]): void {
  set(next)
}
