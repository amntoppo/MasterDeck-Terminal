import { useEffect, useRef } from 'react'

/**
 * Details → Diff stays live by asking main again: every PULL_MS while it is on screen and the
 * window is visible, and at once when the session's state changes (a turn ended). Nothing about
 * changed files is in AppState (the bridge's state budget), and nothing runs while nobody looks.
 */
export const PULL_MS = 3000
/** How often the schedule is looked at; looking re-renders nothing. */
const CHECK_MS = 500

export function pullDue(p: { now: number; last: number | null; visible: boolean; changed: boolean }): boolean {
  if (!p.visible) return false
  return p.last === null || p.changed || p.now - p.last >= PULL_MS
}

const pageVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

/**
 * Run `pull` on that schedule while `on`; `trigger` (the session's state) changing pulls at once.
 * A pull never overlaps the last one. `pull` answers false when it did not ask (its view is
 * hidden): that does not count as a pull, so the view asks as soon as it shows again.
 */
export function usePull(on: boolean, trigger: unknown, pull: () => Promise<boolean | void>): void {
  const last = useRef<number | null>(null)
  const seen = useRef(trigger)
  const busy = useRef(false)
  const pullRef = useRef(pull)
  pullRef.current = pull
  const triggerRef = useRef(trigger)
  triggerRef.current = trigger
  const check = useRef(() => {})
  check.current = () => {
    if (busy.current) return
    const changed = seen.current !== triggerRef.current
    if (!pullDue({ now: Date.now(), last: last.current, visible: pageVisible(), changed })) return
    seen.current = triggerRef.current
    busy.current = true
    void pullRef
      .current()
      .then((asked) => {
        if (asked !== false) last.current = Date.now()
      })
      .catch(() => {
        last.current = Date.now()
      })
      .finally(() => {
        busy.current = false
      })
  }
  useEffect(() => {
    if (!on) {
      last.current = null
      return
    }
    check.current()
    const t = setInterval(() => check.current(), CHECK_MS)
    const onVis = () => check.current()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [on])
  // A new trigger pulls now, not at the next look.
  useEffect(() => {
    if (on) check.current()
  }, [on, trigger])
}
