import { useSyncExternalStore } from 'react'
import { ALL } from '@shared/sessionGroups'
import { load, save } from './deck'

/**
 * The session list's tab on screen (#146), per window or browser, kept in localStorage. One store,
 * so the start dialogs default to it and a start can switch the list to its session's tab (#171).
 */
const KEY = 'sessionGroup'
let picked: string = load<string>(KEY, ALL)
const listeners = new Set<() => void>()

export function pickedGroup(): string {
  return picked
}

export function pickGroup(id: string): void {
  if (id === picked) return
  picked = id
  save(KEY, id)
  for (const l of listeners) l()
}

export function usePickedGroup(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => picked,
  )
}
