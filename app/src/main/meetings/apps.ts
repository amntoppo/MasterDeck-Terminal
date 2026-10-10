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

/**
 * The offer (spec §2): every OFFER_POLL_MS, while allowed and nothing records, one `ps`. An app that
 * was not in a call at the last look and is now is a new call: one offer, and never again for that
 * call (Not now, Record, or an offer already showing for another app). It only offers; recording
 * starts from the user's Record alone.
 */
export class OfferWatch {
  /** The apps in a call at the last look. Kept while not looking, so a call is not new after a recording. */
  private inCall = new Set<string>()
  private shown: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false

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
    const now = callApps(out)
    if (this.shown && !now.includes(this.shown)) this.drop()
    for (const app of now) {
      if (this.inCall.has(app) || this.shown) continue
      this.shown = app
      this.d.offer(app)
    }
    this.inCall = new Set(now)
  }

  /** Not now, or Record pressed: the chip goes; this call is not offered again. */
  dismiss(): void {
    this.drop()
  }

  start(every = OFFER_POLL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), every)
    this.timer.unref?.()
  }

  /** Turn off meetings: no more looks, the chip goes, and the next start begins afresh. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.inCall.clear()
    this.drop()
  }

  get running(): boolean {
    return this.timer !== null
  }
}
