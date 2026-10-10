import { execFile } from 'node:child_process'
import { callApps, OFFER_POLL_MS, PS_TIMEOUT_MS } from '@shared/meetingApps'

/** One `ps -axo comm` (the executables' paths only: no arguments, nothing else is read). */
export function psComm(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'comm'], { timeout: PS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

export interface OfferWatchDeps {
  ps(): Promise<string>
  /** macOS, the consent holds and Settings → Meetings' Offer to record is on. */
  allowed(): boolean
  /** A meeting is being recorded now: no look, no offer. */
  recording(): boolean
  /** A call began: offer it (the rail chip, a notification). */
  offer(app: string): void
  /** The offered call ended, offers were turned off or a recording started: the chip goes. */
  clear(): void
}

/** Looks in a row an app must be missing before its call counts as ended (a helper restarting, a breakout room). */
export const MISSES_TO_END = 3

/**
 * The offer (spec §2): every OFFER_POLL_MS, while allowed and nothing records, one `ps`. An app that
 * is in a call now and was not at the last looks is a new call: one offer, and never again for that
 * call (Not now, Record). A call counts as ended only after MISSES_TO_END looks without it, so a
 * call helper that blinks out for a look is not offered again. An app found while another's offer
 * shows waits: it is offered once that chip goes, if its call still runs. It only offers; recording
 * starts from the user's Record alone.
 */
export class OfferWatch {
  /**
   * The apps whose call was offered (or ran through a recording), with how many looks in a row each
   * has been missing. Kept while not looking, so a call is not new after a recording.
   */
  private inCall = new Map<string, number>()
  private shown: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  /** stop() ran: a look whose ps was still running offers nothing. */
  private stopped = false

  constructor(private d: OfferWatchDeps) {}

  /** The app offered now, or null. */
  get offered(): string | null {
    return this.shown
  }

  private drop(): void {
    if (this.shown === null) return
    this.shown = null
    this.d.clear()
  }

  /** One look. */
  async tick(): Promise<void> {
    if (this.busy) return
    if (!this.d.allowed() || this.d.recording()) return this.drop()
    this.busy = true
    let out: string
    try {
      out = await this.d.ps()
    } catch (err) {
      console.error(`meetings: offer: ps: ${String(err)}`)
      return
    } finally {
      this.busy = false
    }
    // Things may have changed while ps ran.
    if (!this.d.allowed() || this.d.recording()) return this.drop()
    if (this.stopped) return
    const now = callApps(out)
    if (this.shown && !now.includes(this.shown)) this.drop()
    for (const [app, misses] of this.inCall) {
      if (now.includes(app)) this.inCall.set(app, 0)
      else if (misses + 1 >= MISSES_TO_END) this.inCall.delete(app)
      else this.inCall.set(app, misses + 1)
    }
    for (const app of now) {
      // One chip at a time: an app not offered yet stays out of inCall, so it is offered next.
      if (this.inCall.has(app) || this.shown) continue
      this.shown = app
      this.inCall.set(app, 0)
      this.d.offer(app)
    }
  }

  /** Not now, or Record pressed: the chip goes; this call is not offered again. */
  dismiss(): void {
    this.drop()
  }

  start(every = OFFER_POLL_MS): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => void this.tick(), every)
    this.timer.unref?.()
  }

  /** Turn off meetings: no more looks, the chip goes, and the next start begins afresh. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopped = true
    this.inCall.clear()
    this.drop()
  }

  get running(): boolean {
    return this.timer !== null
  }
}
