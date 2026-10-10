import {
  CAPTURE_PARTITION,
  MEETINGS_CONSENT_VERSION,
  MEETINGS_MAC_ONLY,
  mediaAllowed,
  meetingsAgreed,
  type MeetingsAnswer,
  type MeetingsSettings,
} from '@shared/meetings'
import { isRemote } from './ipcRegistry'
// A type only: erased from the build, so this file never loads main/meetings/ by itself.
import type { MeetingsGate } from './meetings/gate'

type GateModule = typeof import('./meetings/gate')

export interface MeetingsDeps {
  platform: string
  /** Settings → Meetings as stored now. */
  meetings(): MeetingsSettings
  /** Store Settings → Meetings (the whole settings file, atomically). */
  setMeetings(m: MeetingsSettings): void
  /** process.getSystemVersion(); read only when the gate loads. */
  macosVersion(): string
  now?: () => number
  /** How main/meetings/gate.ts is loaded (tests count it); default a dynamic import. */
  load?: () => Promise<GateModule>
}

/**
 * The meetings:* handlers' logic (main/index.ts registers them). Spec §1: nothing here runs at
 * startup, and main/meetings/ is loaded only the first time Settings → Meetings asks for its state
 * or after consent. Every call from a browser, and every call off macOS, is refused.
 */
export class MeetingsIpc {
  private gate: Promise<MeetingsGate> | null = null
  constructor(private d: MeetingsDeps) {}

  /** Whether main/meetings/ was loaded (the startup test). */
  get loaded(): boolean {
    return this.gate !== null
  }

  private refused(e: unknown): MeetingsAnswer | null {
    if (this.d.platform !== 'darwin') return { ok: false, message: MEETINGS_MAC_ONLY }
    if (isRemote(e)) return { ok: false, message: 'Meetings are set up in MasterDeck on the Mac.' }
    return null
  }

  /** The gate, loaded once. The recorder fills its probeSystemAudio. */
  loadGate(): Promise<MeetingsGate> {
    const load = this.d.load ?? (() => import('./meetings/gate'))
    this.gate ??= load().then(
      (m) =>
        new m.MeetingsGate({
          meetings: () => this.d.meetings(),
          saveSystemAudio: (systemAudio) => this.d.setMeetings({ ...this.d.meetings(), systemAudio }),
          macosVersion: this.d.macosVersion(),
          now: this.d.now,
        }),
    )
    return this.gate
  }

  async setup(e: unknown): Promise<MeetingsAnswer> {
    return this.refused(e) ?? (await this.loadGate()).setup()
  }

  /** I agree (true) stores the consent; Turn off meetings (false) clears it and leaves the stored meetings. */
  async consent(e: unknown, agree: unknown): Promise<MeetingsAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (typeof agree !== 'boolean') return { ok: false, message: 'Not a consent.' }
    const m = this.d.meetings()
    this.d.setMeetings(
      agree
        ? { ...m, consentAt: (this.d.now ?? Date.now)(), consentVersion: MEETINGS_CONSENT_VERSION }
        : { ...m, consentAt: null, consentVersion: 0 },
    )
    return (await this.loadGate()).setup()
  }

  async permission(e: unknown, kind: unknown): Promise<MeetingsAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (kind !== 'mic' && kind !== 'screen') return { ok: false, message: 'Not a permission.' }
    // Checked here too, so a refusal never loads the gate.
    if (!meetingsAgreed({ meetings: this.d.meetings() })) return { ok: false, message: 'Agree to how meetings work first.' }
    return (await this.loadGate()).permission(kind)
  }
}

/** The part of an Electron session the media guard sets. */
export interface PermissionSession {
  setPermissionRequestHandler(h: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(h: (wc: unknown, permission: string) => boolean): void
}

/** The microphone and screen capture: refused in this session, or (the capture partition) allowed only while agreed. */
export function guardMedia(ses: PermissionSession, inCapture: boolean, agreed: () => boolean): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(mediaAllowed(permission, inCapture, agreed())))
  ses.setPermissionCheckHandler((_wc, permission) => mediaAllowed(permission, inCapture, agreed()))
}

/**
 * Guards every session: the default one (the window), the capture partition, and any made later.
 * Only sets handlers: it asks macOS nothing and opens no window.
 */
export function guardSessions(
  electronApp: { on(event: 'session-created', fn: (s: PermissionSession) => void): unknown },
  sessions: { defaultSession: PermissionSession; fromPartition(p: string): PermissionSession },
  agreed: () => boolean,
): void {
  const capture = sessions.fromPartition(CAPTURE_PARTITION)
  guardMedia(sessions.defaultSession, false, agreed)
  guardMedia(capture, true, agreed)
  electronApp.on('session-created', (s) => {
    if (s !== capture && s !== sessions.defaultSession) guardMedia(s, false, agreed)
  })
}
