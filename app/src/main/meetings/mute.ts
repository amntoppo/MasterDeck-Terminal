import { MUTE_RULES, MuteSettle, muteRuleId, pickApp, type MuteReading, type MuteRule } from '@shared/meetingMute'
import type { MicLive, MicMode, MicUnknown } from '@shared/meetings'
import { findMute, spawnMute, type MuteHelper, type MuteWhere } from './muteHelper'

export interface MuteWatchDeps {
  /** Settings → Meetings' Your microphone, as stored now. */
  mode(): MicMode
  /** Accessibility is allowed (the gate's non-prompting read). */
  trusted(): boolean
  /** Where md-mute may be (findMute). */
  where(): MuteWhere
  /** The recorder's mic gate (Recorder.setMicGate; it sends nothing for a value it has). */
  gate(on: boolean): void
  /** What live() says changed: AppState.meetingLive is read again. */
  onChange(): void
  /** How md-mute is started (tests pass a fake); default spawnMute. */
  spawn?: (bin: string, rules: readonly MuteRule[]) => MuteHelper
  rules?: readonly MuteRule[]
}

/** The recording as the watch needs it. */
export interface RecordingNow {
  recording: boolean
  paused: boolean
}

/** md-mute processes started again after one ended, per recording. */
export const MUTE_RESTARTS = 3

/**
 * The mic follows the meeting app's mute (Plan M). md-mute runs from begin() (just before the
 * recording starts) while a recording runs (not paused), in 'follow' mode and with Accessibility
 * allowed; anything else kills it. The gate is `manualOff || (follow && settled === 'muted')`,
 * sent to the recorder on every change: an unknown mute (no app found, no Accessibility, no
 * helper, a helper that died) never gates, so the mic records as it did before. The first
 * 'muted' reading gates at once; back to the mic takes two 'unmuted' readings or about 3 s of
 * 'unknown' (MuteSettle), also when the followed app changes. The recorder keeps its gate from
 * one recording to the next: begin() sets it at every start, and every way out of following sets
 * it off.
 */
export class MuteWatch {
  private helper: MuteHelper | null = null
  private settle = new MuteSettle()
  /** The rule id the mic follows now. */
  private app: string | null = null
  /** The offered call app's rule id (the recording's): md-mute gets only its rule then. */
  private preferred: string | null = null
  private manualOff = false
  private active = false
  private paused = false
  /** Why nothing can be read at all (null: md-mute runs and reads). */
  private cause: 'not-trusted' | 'no-helper' | null = null
  private gated = false
  /** md-mute processes that ended (or failed to start) in this recording: past MUTE_RESTARTS, no more. */
  private deaths = 0
  private lastKey = ''
  private readonly rules: readonly MuteRule[]

  constructor(private d: MuteWatchDeps) {
    this.rules = d.rules ?? MUTE_RULES
  }

  private get follow(): boolean {
    return this.d.mode() === 'follow'
  }

  /**
   * A recording is about to start (call it before Recorder.start): the manual switch goes off,
   * nothing of the last recording's mute carries over, and the recorder's gate is set again.
   */
  begin(preferred: string | null): void {
    this.kill()
    this.preferred = preferred ? muteRuleId(preferred, this.rules) : null
    this.manualOff = false
    this.reset()
    this.deaths = 0
    this.active = false
    this.paused = false
    this.apply(true)
    // md-mute starts now, before Recorder.start: its first reading (a tick at once) can gate
    // before the capture page opens the mic. One that has not come yet leaves the mic ungated,
    // as without md-mute. A start that fails is cleaned up by the sync after it.
    if (this.follow) this.startHelper()
  }

  /** The recording now: md-mute is started or killed to match (start, pause, stop, a mode change, a new grant). */
  sync(rec: RecordingNow): void {
    if (!rec.recording) {
      if (!this.active && !this.helper) return
      this.kill()
      this.active = false
      this.paused = false
      this.manualOff = false
      this.deaths = 0
      this.reset()
      this.apply(true)
      return
    }
    this.active = true
    this.paused = rec.paused
    if (!this.follow) {
      // 'always': nothing to read.
      this.kill()
      this.reset()
    } else if (rec.paused) {
      // Nothing is recorded while paused. The settled mute is kept: a resume while still muted
      // starts gated, and an unmute during the pause takes two readings (800 ms) to let the mic in.
      this.kill()
    } else if (!this.helper) {
      this.startHelper()
    }
    this.apply()
  }

  /** The Record popout's Mic off in the recording (the window's only; reset by the next begin()). */
  setManualOff(on: boolean): void {
    this.manualOff = on
    this.apply()
  }

  /** Quit, Turn off: md-mute goes now (it also ends by itself when MasterDeck does), and the gate with it. */
  stop(): void {
    this.sync({ recording: false, paused: false })
    this.kill()
  }

  /** Whether md-mute runs (tests). */
  get running(): boolean {
    return this.helper !== null
  }

  /**
   * Following, recording and not paused, but md-mute cannot run yet (no Accessibility, no helper,
   * one that ended with restarts left): MeetingsIpc syncs again every 5 s, so a grant
   * made in System Settings during the call, or a restart, takes effect without a pause.
   */
  get waiting(): boolean {
    return (
      this.active &&
      !this.paused &&
      this.follow &&
      !this.helper &&
      (this.cause === 'not-trusted' || this.cause === 'no-helper') &&
      this.deaths <= MUTE_RESTARTS
    )
  }

  live(): MicLive | null {
    if (!this.active) return null
    const follow = this.follow
    const rule = this.app ? this.rules.find((r) => r.id === this.app) : undefined
    const state = follow ? this.settle.state : 'unknown'
    let reason: MicUnknown | null = null
    if (follow && state === 'unknown') reason = this.cause ?? (this.app ? 'unreadable' : 'no-app')
    return {
      mode: follow ? 'follow' : 'always',
      app: follow ? (rule?.name ?? null) : null,
      state,
      manualOff: this.manualOff,
      kept: !this.gated && !this.paused,
      reason,
    }
  }

  private reset(): void {
    this.settle.reset()
    this.app = null
    this.cause = null
  }

  private kill(): void {
    const h = this.helper
    this.helper = null
    h?.kill()
  }

  private startHelper(): void {
    if (this.deaths > MUTE_RESTARTS) {
      // It kept ending: not again in this recording (the mic records, unknown).
      this.reset()
      this.cause = 'no-helper'
      return
    }
    let trusted = false
    try {
      trusted = this.d.trusted()
    } catch (e) {
      console.error(`meetings: accessibility: ${String(e)}`)
    }
    if (!trusted) {
      this.reset()
      this.cause = 'not-trusted'
      return
    }
    const bin = findMute(this.d.where())
    if (!bin) {
      this.reset()
      this.cause = 'no-helper'
      return
    }
    // The call app's rule alone when it is known: md-mute then looks into no other app (and sets
    // nothing on a browser for Meet). Unknown: every rule.
    const rule = this.preferred ? this.rules.find((r) => r.id === this.preferred) : undefined
    let h: MuteHelper
    try {
      h = (this.d.spawn ?? spawnMute)(bin, rule ? [rule] : this.rules)
    } catch (e) {
      console.error(`meetings: md-mute: ${String(e)}`)
      this.deaths++
      this.reset()
      this.cause = 'no-helper'
      return
    }
    this.helper = h
    this.cause = null
    h.onLine((r) => this.reading(h, r))
    h.onExit((code, error) => {
      if (this.helper !== h) return
      // ponytail: a helper that dies is started again by the next sync (MeetingsIpc's 5 s retry,
      // or any other), at most MUTE_RESTARTS times per recording, with no backoff; the mic records
      // meanwhile (unknown). Upgrade: a backoff, and a notice when it gives up.
      console.error(`meetings: md-mute ended (${code ?? 'signal'})${error ? `: ${error}` : ''}`)
      this.deaths++
      this.helper = null
      this.reset()
      this.cause = 'no-helper'
      this.apply()
    })
  }

  private reading(h: MuteHelper, r: MuteReading): void {
    if (this.helper !== h) return
    if (!r.trusted) {
      // Accessibility was taken back during the call (or does not reach the helper).
      this.reset()
      this.cause = 'not-trusted'
      return this.apply()
    }
    this.cause = null
    // The offered call app while md-mute lists it; else the app followed now while it reads (or,
    // settled muted, while it is listed at all: a gap in its reading is not a reason to follow
    // another app); else the first app it can read; else the first it lists (unknown: "can't see
    // your mute in …").
    const listed = (id: string | null) => !!id && r.apps.some((a) => a.id === id)
    const reads = (id: string | null) => !!id && r.apps.some((a) => a.id === id && a.state !== 'unknown')
    const keep = reads(this.app) || (this.settle.state === 'muted' && listed(this.app))
    const sticky = this.preferred ?? (keep ? this.app : null)
    const id = pickApp(r.apps, sticky, this.rules) ?? r.apps[0]?.id ?? null
    if (id !== this.app) {
      // Muted stays muted until the new app's own readings leave it (MuteSettle.switched).
      this.settle.switched()
      this.app = id
    }
    this.settle.push(id ? (r.apps.find((a) => a.id === id)?.state ?? 'unknown') : 'unknown')
    this.apply()
  }

  /** The gate from the state now, to the recorder (it drops a value it has); onChange when live() changed. */
  private apply(force = false): void {
    const gated = this.manualOff || (this.follow && this.settle.state === 'muted')
    if (force || gated !== this.gated) {
      this.gated = gated
      this.d.gate(gated)
    }
    const key = JSON.stringify(this.live())
    if (key !== this.lastKey) {
      this.lastKey = key
      this.d.onChange()
    }
  }
}
