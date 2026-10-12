import { useEffect, useRef, useState } from 'react'

/**
 * Details → Diff stays live by asking main again: every PULL_MS while it is on screen and the
 * window is visible, and at once when the session's state changes (a turn ended). Nothing about
 * changed files is in AppState (the bridge's state budget), and nothing runs while nobody looks.
 */
export const PULL_MS = 3000

export function pullDue(p: { now: number; last: number | null; visible: boolean; changed: boolean }): boolean {
  if (!p.visible) return false
  return p.last === null || p.changed || p.now - p.last >= PULL_MS
}

const pageVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

/**
 * Run `pull` on that schedule while `on`; `trigger` (the session's state) changing pulls at once.
 * A pull never overlaps the last one.
 */
export function usePull(on: boolean, trigger: unknown, pull: () => Promise<void>): void {
  const last = useRef<number | null>(null)
  const seen = useRef(trigger)
  const busy = useRef(false)
  const pullRef = useRef(pull)
  pullRef.current = pull
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!on) {
      last.current = null
      return
    }
    const t = setInterval(() => setTick((n) => n + 1), 500)
    const onVis = () => setTick((n) => n + 1)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [on])
  useEffect(() => {
    if (!on || busy.current) return
    const changed = seen.current !== trigger
    if (!pullDue({ now: Date.now(), last: last.current, visible: pageVisible(), changed })) return
    seen.current = trigger
    busy.current = true
    void pullRef
      .current()
      .catch(() => {})
      .finally(() => {
        busy.current = false
        last.current = Date.now()
      })
  }, [on, trigger, tick])
}
