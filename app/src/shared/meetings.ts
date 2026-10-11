import type { MuteState } from './meetingMute'

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
  /**
   * Your microphone while recording: 'follow' keeps it out while the meeting app has you muted
   * (read through Accessibility by md-mute; main/meetings/mute.ts), 'always' records it throughout.
   */
  mic: MicMode
}

/** Settings → Meetings' Your microphone. */
export type MicMode = 'follow' | 'always'

export const DEFAULT_MEETINGS: MeetingsSettings = {
  consentAt: null,
  consentVersion: 0,
  model: null,
  language: 'auto',
  offer: true,
  deleteAudioAfterDays: 30,
  systemAudio: null,
  mic: 'follow',
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
    // Settings from before Plan M have none: they follow the meeting app's mute.
    mic: r.mic === 'always' ? 'always' : 'follow',
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
  /**
   * Accessibility (md-mute reads the meeting app's mute through it): granted, or not-determined
   * until Allow was pressed in this run, denied after that while still not granted (macOS has no
   * read of a refusal: isTrustedAccessibilityClient says only yes or no).
   */
  accessibility: MediaStatus
  systemAudio: SystemAudioPath
  /** The speech model (filled by the model download, a later step). */
  model: { name: string | null; ready: boolean }
  settings: MeetingsSettings
  /** What the action did, when there is something to say (System Settings opened, …). */
  message?: string
}
export type MeetingsAnswer = MeetingsSetupInfo | { ok: false; message: string }

/** What Settings → Meetings' Allow buttons ask for (meetings:permission). */
export type MeetingsGrant = 'mic' | 'screen' | 'accessibility'
export const MEETINGS_GRANTS: readonly MeetingsGrant[] = ['mic', 'screen', 'accessibility']

/** The sound row's status: the stored check (14.2+), the Screen Recording grant (13 to 14.1), or none. */
export function soundStatus(path: SystemAudioPath, screenGrant: MediaStatus, check: SystemAudioCheck | null): SoundStatus {
  if (path === 'none') return 'unsupported'
  if (path === 'screen') return screenGrant
  return check ? (check.ok ? 'granted' : 'silent') : 'not-checked'
}

/** System Settings' pane for a grant. Privacy_AudioCapture is System Audio Recording Only (14.2+). */
export function privacyPane(kind: MeetingsGrant, path: SystemAudioPath): string {
  const anchor =
    kind === 'mic'
      ? 'Privacy_Microphone'
      : kind === 'accessibility'
        ? 'Privacy_Accessibility'
        : path === 'tap'
          ? 'Privacy_AudioCapture'
          : 'Privacy_ScreenCapture'
  return `x-apple.systempreferences:com.apple.preference.security?${anchor}`
}

// ── Recording (spec §2, §8) ─────────────────────────────────────────────────

/** A meeting's life: recorded, its chunks turned into text, matched to sessions, then done (or failed with a reason). */
export type MeetingState = 'recording' | 'transcribing' | 'matching' | 'done' | 'failed'
export const MEETING_STATES: readonly MeetingState[] = ['recording', 'transcribing', 'matching', 'done', 'failed']
/** Who spoke: the microphone (you) or the sound the Mac played (the others). Also a chunk's track. */
export type Speaker = 'you' | 'others'
export const TRACKS: readonly Speaker[] = ['you', 'others']

/** One line of the transcript; start and end in ms from the start of the recording (paused time not counted). */
export interface Segment {
  start: number
  end: number
  speaker: Speaker
  text: string
}

/** What the matching call (a later step) tied to a session, ticket or PR: its label, the note it wrote, the segment indexes. */
export interface MeetingMatch {
  label: string
  noteId: string | null
  segments: number[]
}

/**
 * A meeting's Needs-you item (spec §10), kept by main/meetingNotices.ts: notes were added (Open),
 * matching failed (Match again), transcription failed (Try again). One per meeting; `at` makes a
 * new one a new item. Never in toRemoteSnapshot (shared/remoteSnapshot.ts leaves the kind out).
 */
export type MeetingNotice =
  | { meetingId: string; title: string; at: number; kind: 'added'; sessions: number; tickets: number }
  | { meetingId: string; title: string; at: number; kind: 'unmatched' | 'failed'; reason: string }
export const MEETING_NOTICE_KINDS = ['added', 'unmatched', 'failed'] as const

/**
 * How far the transcript is (the Meetings page shows "Transcribing 3/12"): chunks done, chunks
 * known so far (it grows while recording), and why it waits, when it does ("Waiting for the
 * speech model").
 */
export interface MeetingProgress {
  done: number
  total: number
  wait: string | null
}
export const MEETING_WAIT_MAX = 200

/** MASTERDECK_HOME/meetings/<id>.json */
export interface Meeting {
  id: string
  /** '' until the user or Claude names it. */
  title: string
  /** Who named it; null: no one yet (Claude may propose one). */
  titleBy: 'user' | 'claude' | null
  started: number
  /** Null while recording. */
  ended: number | null
  /** Time the recording was paused, in ms: the transcript's times and the audio leave it out. */
  pausedMs: number
  /** The meeting app whose call was offered when the recording started (main/meetings/apps.ts). */
  apps: string[]
  state: MeetingState
  /** The speech model and language the recording started with (Settings → Meetings). */
  model: string | null
  language: string
  segments: Segment[]
  summary: string | null
  matches: MeetingMatch[]
  /** The transcription's progress; null before the first chunk (and in files written before it). */
  progress: MeetingProgress | null
  /** Why it failed, or what went wrong while recording; plain text MasterDeck wrote. */
  error: string | null
}

/** Stops a recording (spec §2: a notice says so). */
export const MEETING_MAX_MS = 4 * 60 * 60 * 1000
/** One WAV per track per 30 s, transcribed as it closes. A chunk's offset is seq × CHUNK_MS. */
export const CHUNK_MS = 30_000
export const SAMPLE_RATE = 16_000
export const CHUNK_SAMPLES = (SAMPLE_RATE * CHUNK_MS) / 1000
/** A 30-second 16 kHz mono Int16 WAV is 960,044 bytes. */
export const CHUNK_MAX_BYTES = 1024 * 1024
/** 4 hours of 30-second chunks is 480, with room. */
export const CHUNK_SEQ_MAX = 1000
/** The playback copy (audio.webm): Opus at 32 kbit/s, sent in 10-second slices. */
export const AUDIO_SLICE_MS = 10_000
export const AUDIO_BITS = 32_000
export const AUDIO_SLICE_MAX_BYTES = 1024 * 1024
/** 4 hours at 32 kbit/s is about 58 MB; a file past this is not appended to. */
export const AUDIO_MAX_BYTES = 200 * 1024 * 1024
export const MEETING_SEGMENTS_MAX = 20_000
export const SEGMENT_TEXT_MAX = 2000
export const MEETING_SUMMARY_MAX = 4000
export const MEETING_ERROR_MAX = 500

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
const LINE_CONTROL = /[\x00-\x1f\x7f-\x9f]/
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A title from the window: trimmed, one line, at most MEETING_TITLE_MAX; null when it is not one. '' is no title. */
export function cleanTitle(raw: unknown): string | null {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (t.length > MEETING_TITLE_MAX || LINE_CONTROL.test(t)) return null
  return t
}

function asSegment(v: unknown): Segment | null {
  const s = record(v)
  if (!s || !time(s.start) || !time(s.end) || s.end < s.start) return null
  if (s.speaker !== 'you' && s.speaker !== 'others') return null
  if (typeof s.text !== 'string' || s.text.length > SEGMENT_TEXT_MAX || CONTROL.test(s.text)) return null
  return { start: s.start, end: s.end, speaker: s.speaker, text: s.text }
}

function asMatch(v: unknown, segments: number): MeetingMatch | null {
  const m = record(v)
  if (!m || typeof m.label !== 'string' || m.label.length > 300 || LINE_CONTROL.test(m.label)) return null
  if (m.noteId !== null && (typeof m.noteId !== 'string' || !/^[nt]-[\w-]{1,200}$/.test(m.noteId))) return null
  if (!Array.isArray(m.segments) || m.segments.length > segments) return null
  if (!m.segments.every((i) => Number.isInteger(i) && i >= 0 && i < segments)) return null
  return { label: m.label, noteId: m.noteId, segments: m.segments as number[] }
}

/** A meeting file as read from disk, or null when it is not a meeting MasterDeck wrote under this id (never overwritten then). */
export function storedMeeting(raw: unknown, id: string): Meeting | null {
  const o = record(raw)
  if (!o || o.id !== id || !MEETING_ID.test(id)) return null
  const title = typeof o.title === 'string' ? cleanTitle(o.title) : null
  if (title === null || title !== o.title) return null
  if (o.titleBy !== 'user' && o.titleBy !== 'claude' && o.titleBy !== null) return null
  if (!time(o.started) || !(o.ended === null || (time(o.ended) && o.ended >= o.started))) return null
  if (!time(o.pausedMs)) return null
  if (!Array.isArray(o.apps) || o.apps.length > 20 || !o.apps.every((a) => typeof a === 'string' && a.length <= 60 && !LINE_CONTROL.test(a))) return null
  if (!MEETING_STATES.includes(o.state as MeetingState)) return null
  if (o.model !== null && (typeof o.model !== 'string' || !MODEL_NAME.test(o.model))) return null
  if (typeof o.language !== 'string' || !LANGUAGE.test(o.language)) return null
  if (!Array.isArray(o.segments) || o.segments.length > MEETING_SEGMENTS_MAX) return null
  const segments: Segment[] = []
  for (const s of o.segments) {
    const seg = asSegment(s)
    if (!seg) return null
    segments.push(seg)
  }
  if (o.summary !== null && (typeof o.summary !== 'string' || o.summary.length > MEETING_SUMMARY_MAX || CONTROL.test(o.summary))) return null
  if (!Array.isArray(o.matches) || o.matches.length > 200) return null
  const matches: MeetingMatch[] = []
  for (const m of o.matches) {
    const match = asMatch(m, segments.length)
    if (!match) return null
    matches.push(match)
  }
  if (o.error !== null && (typeof o.error !== 'string' || o.error.length > MEETING_ERROR_MAX || CONTROL.test(o.error))) return null
  // Missing in the files of the first recordings: no progress then.
  const progress = o.progress === undefined || o.progress === null ? null : asProgress(o.progress)
  if (progress === undefined) return null
  return {
    id,
    title,
    titleBy: o.titleBy,
    started: o.started,
    ended: o.ended,
    pausedMs: o.pausedMs,
    apps: o.apps as string[],
    state: o.state as MeetingState,
    model: o.model,
    language: o.language,
    segments,
    summary: o.summary,
    matches,
    progress,
    error: o.error,
  }
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10 * CHUNK_SEQ_MAX

/** A stored progress, or undefined when it is not one. */
function asProgress(v: unknown): MeetingProgress | undefined {
  const p = record(v)
  if (!p || !count(p.done) || !count(p.total)) return undefined
  if (p.wait !== null && (typeof p.wait !== 'string' || p.wait.length > MEETING_WAIT_MAX || LINE_CONTROL.test(p.wait))) return undefined
  return { done: p.done, total: p.total, wait: p.wait }
}

/** Both tracks' segments as one transcript, by start time; where both talk at once both lines stay (you first on a tie). */
export function mergeSegments(you: Segment[], others: Segment[]): Segment[] {
  const all = [...you.map((s) => ({ ...s, speaker: 'you' as const })), ...others.map((s) => ({ ...s, speaker: 'others' as const }))]
  // Array.prototype.sort is stable: within a track the order it came in stays.
  return all.sort((a, b) => a.start - b.start || (a.speaker === b.speaker ? 0 : a.speaker === 'you' ? -1 : 1))
}

/**
 * The rail's recording indicator (AppState.meetingLive). Never in toRemoteSnapshot; it does reach
 * approved web tabs with the rest of the state (the bridge's state event, through webState, which
 * blanks `offer`), so they learn only that a recording runs, never which call app is in use: the
 * web app shows nothing of it and cannot start, pause or stop one.
 * `since` is when the recording would have started had it never been paused, so while it runs the
 * time recorded is now − since; while paused it is `elapsed`.
 */
export interface MeetingLive {
  recording: boolean
  since: number | null
  paused: boolean
  /** Time recorded so far, in ms, as of the last change (what the rail shows while paused). */
  elapsed: number
  /** The meeting app in a call that MasterDeck offers to record (main/meetings/apps.ts), or null; null while recording. */
  offer: string | null
  /** Your microphone in the recording (main/meetings/mute.ts); null while nothing records. */
  mic: MicLive | null
}
export const IDLE_LIVE: MeetingLive = { recording: false, since: null, paused: false, elapsed: 0, offer: null, mic: null }

/**
 * Your microphone in the recording now (the Record popout's line and switch). `kept`: the mic goes
 * into the recording now (not gated, not paused). `state` is the meeting app's mute as md-mute
 * settled it, `app` the rule's name it follows ("Zoom"; null: none found), and `reason` why the
 * state is unknown while following (null otherwise). Unknown never gates: the mic records as
 * before Plan M.
 */
export interface MicLive {
  mode: MicMode
  app: string | null
  state: MuteState
  manualOff: boolean
  kept: boolean
  /** The recording is paused (nothing of the mic is recorded). */
  paused: boolean
  reason: MicUnknown | null
}

/**
 * Why the mute is not known: Accessibility not allowed, or lost (an update of an ad-hoc signed
 * build: "Allow again in Settings → Meetings"); md-mute missing (`no-helper`) or ended
 * (`helper-ended`: started again by the next sync); no meeting app found; an app found whose
 * control could not be read.
 */
export type MicUnknown = 'not-trusted' | 'no-helper' | 'helper-ended' | 'no-app' | 'unreadable'

/**
 * The state as web tabs get it: the offered call app and the app the mic follows (which app the
 * user is in a call with) stay on the Mac.
 */
export function webState<T extends { meetingLive?: MeetingLive | null }>(state: T): T {
  const live = state?.meetingLive
  if (!live || (live.offer === null && (live.mic?.app ?? null) === null)) return state
  return { ...state, meetingLive: { ...live, offer: null, mic: live.mic ? { ...live.mic, app: null } : null } }
}

/**
 * The Record popout's mic line. `settings`: the line asks for Settings → Meetings (Accessibility).
 * A web tab has no app name (webState): it says "the meeting app".
 */
export function micLine(mic: MicLive | null | undefined): { text: string; settings: boolean } | null {
  if (!mic) return null
  const say = (text: string, settings = false) => ({ text, settings })
  if (mic.paused) return say('Mic: paused.')
  if (mic.manualOff) return say('Mic: off in the recording.')
  if (mic.mode === 'always') return say('Mic: always recorded.')
  const app = mic.app ?? 'the meeting app'
  switch (mic.reason) {
    case 'not-trusted':
      return say('Mic: recorded. Allow Accessibility in Settings → Meetings to follow your mute.', true)
    case 'no-app':
      return say('Mic: recorded. No meeting app found.')
    case 'unreadable':
      return say(`Mic: recorded. Can't see your mute in ${app}.`)
    case 'no-helper':
      return say('Mic: recorded. The mute reader is missing; reinstall MasterDeck.')
    case 'helper-ended':
      return say('Mic: recorded. The mute reader stopped; trying again.')
  }
  if (mic.state === 'muted') return say(`Mic: muted in ${app} — not recorded`)
  if (mic.state === 'unmuted') return say(`Mic: on in ${app}`)
  return say('Mic: recorded.')
}

/** Time recorded so far: frozen while paused. */
export const recordedMs = (live: MeetingLive, now: number): number => (live.paused || live.since === null ? live.elapsed : Math.max(0, now - live.since))

/** The rail's time: 12:34, or 1:02:03 past an hour. */
export function recordClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`
}

/**
 * One call at a time: while fn's promise is pending every call gets that same promise (later
 * arguments are ignored). Quitting, closing the window and Restart share one "A meeting is being
 * recorded" question this way.
 */
export function oneAtATime<A extends unknown[], T>(fn: (...a: A) => Promise<T>): (...a: A) => Promise<T> {
  let pending: Promise<T> | null = null
  return (...a) =>
    (pending ??= (async () => {
      try {
        return await fn(...a)
      } finally {
        pending = null
      }
    })())
}

/** The answer of meetings:start / stop / pause. */
export type RecordAnswer = { ok: true; live: MeetingLive; id?: string; message?: string } | { ok: false; message: string }

/** Languages on Settings → Meetings (whisper.cpp's codes); 'auto' lets whisper detect it per chunk. */
export const MEETING_LANGUAGES: readonly [string, string][] = [
  ['auto', 'Detect automatically'],
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
  ['fi', 'Finnish'],
  ['pl', 'Polish'],
  ['cs', 'Czech'],
  ['ru', 'Russian'],
  ['uk', 'Ukrainian'],
  ['tr', 'Turkish'],
  ['el', 'Greek'],
  ['ar', 'Arabic'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
  ['id', 'Indonesian'],
  ['vi', 'Vietnamese'],
  ['th', 'Thai'],
]

// ── The capture window's messages (main/meetings/recorder.ts; never on DeckApi) ──

export const CAPTURE_CH = {
  /** capture → main: one 30-second WAV of a track ({ id, track, seq }, bytes). */
  chunk: 'meetings:chunk',
  /** capture → main: a 10-second slice of audio.webm (id, bytes). */
  audio: 'meetings:audio',
  /** capture → main: a track's loudness (RMS 0..1; -1: the track is missing or ended). */
  level: 'meetings:level',
  /** capture → main: the capture window is done (one of CAPTURE_ENDS). */
  ended: 'meetings:ended',
  /** main → capture: pause, resume, stop, mic gate on / off. */
  command: 'meetings:captureCommand',
} as const

/**
 * What main tells the capture page (fixed words: the recorder puts them in a script). 'gate': the
 * microphone is not kept (zeros in the "you" track, nothing into the playback mix); 'ungate': it is.
 */
export type CaptureCommand = 'pause' | 'resume' | 'stop' | 'gate' | 'ungate'
/** Why the capture window ended: Stop pressed, the probe's second is over, or what went wrong. */
export const CAPTURE_ENDS = ['stopped', 'probe', 'no-track', 'mic-refused', 'mic-ended', 'error'] as const
export type CaptureEnd = (typeof CAPTURE_ENDS)[number]
export const asCaptureEnd = (v: unknown): CaptureEnd => (CAPTURE_ENDS.includes(v as CaptureEnd) ? (v as CaptureEnd) : 'error')
/** Below this RMS the probe heard nothing (digital silence is 0; a quiet room on a live track is above it). */
export const PROBE_SILENCE = 0.0005
