/** A meeting's id, and so the name of its folder under MASTERDECK_HOME/meetings: never anything else is used as a path. */
export const MEETING_ID = /^m-[0-9a-f]{32}$/
export const MEETING_TITLE_MAX = 120

/** Raised when what is recorded or what is sent changes: the consent card is shown again. */
export const MEETINGS_CONSENT_VERSION = 1
/** The capture window's session partition: the one place microphone and screen capture may be allowed. */
export const CAPTURE_PARTITION = 'meetings-capture'
/** Every meetings:* handler's answer on Windows and Linux. */
export const MEETINGS_MAC_ONLY = 'Meetings work on macOS only.'

/** The Mac's sound (the other people), as the last check found it: macOS 14.2+ has no API that reads that grant. */
export interface SystemAudioCheck {
  at: number
  ok: boolean
}

/** Settings → Meetings. */
export interface MeetingsSettings {
  /** When the user agreed to the consent card; null: never, or after Turn off meetings. */
  consentAt: number | null
  /** The MEETINGS_CONSENT_VERSION agreed to; another one asks again. */
  consentVersion: number
  /** The speech model's name (picked and downloaded on the same screen). */
  model: string | null
  /** The meetings' language for transcription, or 'auto'. */
  language: string
  /** Offer to record when a meeting app is in a call. */
  offer: boolean
  /** Delete a meeting's audio (the transcript stays) this many days after; null: never. */
  deleteAudioAfterDays: number | null
  /** The last check of the Mac's sound (its Allow on Settings → Meetings); macOS 14.2+ only. */
  systemAudio: SystemAudioCheck | null
}

export const DEFAULT_MEETINGS: MeetingsSettings = {
  consentAt: null,
  consentVersion: 0,
  model: null,
  language: 'auto',
  offer: true,
  deleteAudioAfterDays: 30,
  systemAudio: null,
}

const MODEL_NAME = /^[\w.-]{1,64}$/
const LANGUAGE = /^(auto|[a-z]{2,3})$/
export const DELETE_AUDIO_DAYS_MAX = 3650

const posInt = (v: unknown, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : null
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Settings → Meetings from disk or a call: anything missing or wrong is the default (settings files from before meetings have none). */
export function normalizeMeetings(raw: unknown): MeetingsSettings {
  const r = record(raw) ?? {}
  const at = posInt(r.consentAt, Number.MAX_SAFE_INTEGER)
  const version = posInt(r.consentVersion, 1_000_000)
  const consented = at !== null && version !== null
  const sa = record(r.systemAudio)
  const saAt = sa ? posInt(sa.at, Number.MAX_SAFE_INTEGER) : null
  return {
    // A consent is a time and a version together, or neither.
    consentAt: consented ? at : null,
    consentVersion: consented ? version : 0,
    model: typeof r.model === 'string' && MODEL_NAME.test(r.model) ? r.model : null,
    language: typeof r.language === 'string' && LANGUAGE.test(r.language) ? r.language : DEFAULT_MEETINGS.language,
    offer: typeof r.offer === 'boolean' ? r.offer : DEFAULT_MEETINGS.offer,
    deleteAudioAfterDays:
      r.deleteAudioAfterDays === null ? null : (posInt(r.deleteAudioAfterDays, DELETE_AUDIO_DAYS_MAX) ?? DEFAULT_MEETINGS.deleteAudioAfterDays),
    systemAudio: sa && saAt !== null && typeof sa.ok === 'boolean' ? { at: saAt, ok: sa.ok } : null,
  }
}

/** Whether the user agreed to the current consent card: nothing about meetings asks macOS anything before this. */
export function meetingsAgreed(s: { meetings: MeetingsSettings }): boolean {
  return s.meetings.consentAt !== null && s.meetings.consentVersion === MEETINGS_CONSENT_VERSION
}

/**
 * What a setSettings call may do to Settings → Meetings: never the consent or the sound check
 * (their own channels, meetings:consent and meetings:permission), and nothing at all from a browser.
 */
export function keepMeetings(next: unknown, current: MeetingsSettings, remote: boolean): Record<string, unknown> {
  const n = record(next) ?? {}
  if (remote) return { ...n, meetings: current }
  const m = normalizeMeetings(n.meetings ?? current)
  return { ...n, meetings: { ...m, consentAt: current.consentAt, consentVersion: current.consentVersion, systemAudio: current.systemAudio } }
}

/**
 * Whether a web contents may have a permission. The microphone and screen capture (`media`,
 * `display-capture`) only in the capture window's partition and only while the user agrees.
 * Reading the clipboard (`clipboard-read`, `deprecated-sync-clipboard-read`) never: Electron with
 * no handler refuses the sync read and may or may not grant the async one, while the window and
 * the web app only write to it (`navigator.clipboard.writeText`); a yes here could only widen what
 * a page may do. Everything else is granted, as Electron does with no handler (MasterDeck had none
 * before meetings).
 */
export function mediaAllowed(permission: string, inCapture: boolean, agreed: boolean): boolean {
  if (permission === 'clipboard-read' || permission === 'deprecated-sync-clipboard-read') return false
  if (permission !== 'media' && permission !== 'display-capture') return true
  return inCapture && agreed
}

/** How the Mac's sound is captured on this macOS (OPERATIONS § Meetings: capture). */
export type SystemAudioPath = 'tap' | 'screen' | 'none'

/** macOS 14.2+: Core Audio tap (System Audio Recording Only); 13 to 14.1: ScreenCaptureKit (Screen Recording); older: none. */
export function systemAudioPath(macosVersion: string): SystemAudioPath {
  const [maj = 0, min = 0] = macosVersion.split('.').map((p) => Number.parseInt(p, 10) || 0)
  if (maj > 14 || (maj === 14 && min >= 2)) return 'tap'
  return maj >= 13 ? 'screen' : 'none'
}

/** A macOS privacy grant as getMediaAccessStatus reports it. */
export type MediaStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
/** The Mac's sound: a grant (13 to 14.1), the last check (14.2+: granted or silent), never checked, or none on this macOS. */
export type SoundStatus = MediaStatus | 'not-checked' | 'silent' | 'unsupported'

/** Settings → Meetings' state, the answer of meetings:setup, meetings:consent and meetings:permission. */
export interface MeetingsSetupInfo {
  ok: true
  mac: true
  agreed: boolean
  mic: MediaStatus
  screen: SoundStatus
  systemAudio: SystemAudioPath
  /** The speech model (filled by the model download, a later step). */
  model: { name: string | null; ready: boolean }
  settings: MeetingsSettings
  /** What the action did, when there is something to say (System Settings opened, …). */
  message?: string
}
export type MeetingsAnswer = MeetingsSetupInfo | { ok: false; message: string }

/** The sound row's status: the stored check (14.2+), the Screen Recording grant (13 to 14.1), or none. */
export function soundStatus(path: SystemAudioPath, screenGrant: MediaStatus, check: SystemAudioCheck | null): SoundStatus {
  if (path === 'none') return 'unsupported'
  if (path === 'screen') return screenGrant
  return check ? (check.ok ? 'granted' : 'silent') : 'not-checked'
}

/** System Settings' pane for a grant. Privacy_AudioCapture is System Audio Recording Only (14.2+). */
export function privacyPane(kind: 'mic' | 'screen', path: SystemAudioPath): string {
  const anchor = kind === 'mic' ? 'Privacy_Microphone' : path === 'tap' ? 'Privacy_AudioCapture' : 'Privacy_ScreenCapture'
  return `x-apple.systempreferences:com.apple.preference.security?${anchor}`
}
