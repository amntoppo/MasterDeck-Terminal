import { useRef } from 'react'

/**
 * Every state push is a fresh copy, so a value worked out from it is a new object each time even
 * when nothing in it changed, and a memo()'d component draws again. These keep the last reference
 * while the value's JSON is the same. The value is serialised on every call: use them on small
 * derived views, never on the state or a large slice of it (sessions, issues, the board), where
 * comparing by reference (a draw per push) costs less than the JSON.
 */
export interface Kept<T> {
  v: T
  key: string
}

/** The kept value, or `v` with its key when its JSON differs. */
export function stableNext<T>(prev: Kept<T> | null, v: T): Kept<T> {
  const key = JSON.stringify(v) ?? 'undefined'
  return prev && prev.key === key ? prev : { v, key }
}

export function useStable<T>(v: T): T {
  const ref = useRef<Kept<T> | null>(null)
  ref.current = stableNext(ref.current, v)
  return ref.current.v
}
