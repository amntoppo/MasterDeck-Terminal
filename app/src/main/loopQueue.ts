import type { LoopView } from '@shared/loops'
import type { Session } from '@shared/types'

/** How long after a loop closes MasterDeck still waits for its session to go idle. */
export const LOOP_QUEUE_WAIT_MS = 2 * 60_000
/** A deck-hook handover this long before the closing was seen still counts as the closing turn's. */
const SERVED_SLACK_MS = 30_000

/**
 * The queue after a workflow loop (#82). While a loop is open the deck hook's Stop hands no queued
 * prompt over, and Stop hooks run side by side: on the turn that closes the loop it usually still
 * reads the loop open and skips. When that stop goes through (the loop hook had nothing more to
 * say) the session is left idle with prompts queued and nothing wakes it. This notices a session's
 * open loop going away, waits for the session to be idle, and picks it for the queue's next
 * prompt (sent by the caller as Send next does), once per closing, and only when the deck hook
 * served no prompt to the session since (its answer then already moved the queue on).
 */
export class LoopQueue {
  /** Sessions with an open loop at the last tick. */
  private open = new Set<string>()
  /** Sessions whose loop closed, and when that was seen. */
  private waiting = new Map<string, number>()

  /**
   * The sessions to hand their next queued prompt to now. `queued` counts a session's prompts;
   * `servedAt` is when MasterDeck last answered the deck hook's Stop for it with a prompt.
   */
  tick(
    loops: Record<string, LoopView[]> | undefined,
    sessions: Session[],
    queued: (sessionId: string) => number,
    servedAt: (sessionId: string) => number | undefined,
    now: number,
  ): Session[] {
    const open = new Set(
      Object.entries(loops ?? {})
        .filter(([, v]) => v.some((x) => x.state === 'open'))
        .map(([sid]) => sid),
    )
    for (const sid of this.open) if (!open.has(sid)) this.waiting.set(sid, now)
    this.open = open
    const out: Session[] = []
    for (const [sid, at] of this.waiting) {
      if (open.has(sid) || now - at > LOOP_QUEUE_WAIT_MS) {
        this.waiting.delete(sid)
        continue
      }
      const s = sessions.find((x) => x.sessionId === sid)
      if (!s || s.state !== 'idle') continue
      // Once per closing, whatever comes of it: a second look could send a second prompt.
      this.waiting.delete(sid)
      const served = servedAt(sid)
      if (served !== undefined && served >= at - SERVED_SLACK_MS) continue
      if (queued(sid) > 0) out.push(s)
    }
    return out
  }
}
