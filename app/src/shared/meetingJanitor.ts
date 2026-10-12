import { MEETING_ID } from './meetings'

/**
 * Janitor → Meetings (spec §7): what it lists, the "older than" pick, the totals, the cleanup's
 * request and the daily audio timer's choice. Pure: the Janitor and main both use it.
 */

/** One meeting in Janitor: its date, title and what it takes on disk. */
export interface JanitorMeetingRow {
  id: string
  title: string
  started: number
  audioBytes: number
  transcriptBytes: number
  /** Being recorded now: never picked, never cleaned. */
  recording: boolean
}

export type MeetingsJanitorAnswer = { ok: true; rows: JanitorMeetingRow[] } | { ok: false; message: string }

export const CLEAN_WHATS = ['audio', 'meetings'] as const
export type CleanWhat = (typeof CLEAN_WHATS)[number]
export interface CleanRequest {
  ids: string[]
  what: CleanWhat
}
/** How many were cleaned, and how many were not (being recorded, gone, a disk error). */
export type MeetingsCleanAnswer = { ok: true; done: number; skipped: number; message?: string } | { ok: false; message: string }

/** The "older than" picks, in days. */
export const JANITOR_PICKS = [7, 30, 90] as const
/** More than this many at once: the user types the count first (as Janitor's risky worktrees do). */
export const TYPED_CONFIRM_OVER = 10
/** At most this many in one meetings:clean. */
export const CLEAN_MAX = 2000

export const DAY_MS = 24 * 60 * 60 * 1000
/** The Delete audio after timer: first a while after start (nothing at startup), then daily. */
export const AUDIO_SWEEP_FIRST_MS = 5 * 60 * 1000
export const AUDIO_SWEEP_EVERY_MS = DAY_MS

/** The store's sizes as rows; the one being recorded is marked. */
export function janitorRows(
  sizes: { id: string; title: string; started: number; audio: number; transcript: number }[],
  recordingId: string | null,
): JanitorMeetingRow[] {
  return sizes.map((s) => ({
    id: s.id,
    title: s.title,
    started: s.started,
    audioBytes: s.audio,
    transcriptBytes: s.transcript,
    recording: s.id === recordingId,
  }))
}

/** The meetings that started more than `days` days before now (none being recorded). */
export function pickOlder(rows: JanitorMeetingRow[], days: number, now: number): string[] {
  const before = now - days * DAY_MS
  return rows.filter((r) => !r.recording && r.started < before).map((r) => r.id)
}

export interface JanitorTotals {
  meetings: number
  audioBytes: number
  transcriptBytes: number
}

/** Over every row, or over the picked ones. */
export function janitorTotals(rows: JanitorMeetingRow[], ids?: readonly string[]): JanitorTotals {
  const set = ids ? new Set(ids) : null
  const t: JanitorTotals = { meetings: 0, audioBytes: 0, transcriptBytes: 0 }
  for (const r of rows) {
    if (set && !set.has(r.id)) continue
    t.meetings++
    t.audioBytes += r.audioBytes
    t.transcriptBytes += r.transcriptBytes
  }
  return t
}

/** Whether a cleanup of n meetings needs the count typed first. */
export const needsTypedCount = (n: number): boolean => n > TYPED_CONFIRM_OVER

/** A meetings:clean request from the window, or null when it is not one (ids deduplicated). */
export function cleanRequest(raw: unknown): CleanRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!CLEAN_WHATS.includes(r.what as CleanWhat)) return null
  if (!Array.isArray(r.ids) || r.ids.length === 0 || r.ids.length > CLEAN_MAX) return null
  if (!r.ids.every((id) => typeof id === 'string' && MEETING_ID.test(id))) return null
  return { ids: [...new Set(r.ids as string[])], what: r.what as CleanWhat }
}

/**
 * Delete audio after (Settings → Meetings): the meetings whose audio the daily timer removes. Only
 * audio, never a transcript; none while the setting is never (null), none being recorded.
 */
export function audioExpired(rows: JanitorMeetingRow[], days: number | null, now: number): string[] {
  if (days === null) return []
  return pickOlder(
    rows.filter((r) => r.audioBytes > 0),
    days,
    now,
  )
}

/** 1.2 MB, 340 KB, 0 B. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
