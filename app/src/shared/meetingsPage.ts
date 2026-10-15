import { MIC_LOG_KEEP, recordClock, type Meeting, type MeetingProgress, type MeetingState, type MicLogEntry, type MicUnknown, type MuteWhy, type Segment } from './meetings'
import { MATCH_FAILED, meetingWhen } from './meetingMatch'

/**
 * The Meetings page (spec §6): what it lists, its calendar and ranges, the transcript's search and
 * the playing line, and the Markdown export. Pure: the page and main both use it.
 */

/** The window's audio scheme: `masterdeck-media://meeting/<id>/audio` serves that meeting's audio.webm only (main/meetingMedia.ts). */
export const MEDIA_SCHEME = 'masterdeck-media'
export const meetingAudioUrl = (id: string): string => `${MEDIA_SCHEME}://meeting/${id}/audio`

/** One meeting in the page's list: everything but the transcript. */
export interface MeetingRow {
  id: string
  title: string
  started: number
  ended: number | null
  pausedMs: number
  state: MeetingState
  progress: MeetingProgress | null
  error: string | null
  apps: string[]
  /** How many notes it added (matches that wrote one). */
  notes: number
}

export type MeetingsListAnswer = { ok: true; meetings: MeetingRow[]; agreed: boolean } | { ok: false; message: string }
export type MeetingGetAnswer = { ok: true; meeting: Meeting; audio: boolean } | { ok: false; message: string }
export type MeetingsResult = { ok: true } | { ok: false; message: string }
export const EXPORT_KINDS = ['md', 'audio'] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]

export function meetingRow(m: Meeting): MeetingRow {
  return {
    id: m.id,
    title: m.title,
    started: m.started,
    ended: m.ended,
    pausedMs: m.pausedMs,
    state: m.state,
    progress: m.progress,
    error: m.error,
    apps: m.apps,
    notes: m.matches.filter((x) => x.noteId).length,
  }
}

/** Time recorded: start to end (now while recording), paused time left out. */
export const meetingLengthMs = (m: Pick<MeetingRow, 'started' | 'ended' | 'pausedMs'>, now: number): number =>
  Math.max(0, (m.ended ?? now) - m.started - m.pausedMs)

/** The title, or "Meeting <date time>" for one no one named yet. */
export const meetingTitle = (m: Pick<MeetingRow, 'title' | 'started'>): string => m.title || `Meeting ${meetingWhen(m.started)}`

export interface StateView {
  label: string
  tone: 'live' | 'busy' | 'done' | 'failed'
  /** What the failed state offers: Try again (transcription) or Match again (matching). */
  action: 'retry' | 'rematch' | null
}

/** Recording, Transcribing 3/12, Waiting for the speech model, Matching, Done, Failed. */
export function stateView(m: Pick<MeetingRow, 'state' | 'progress' | 'error'>): StateView {
  switch (m.state) {
    case 'recording':
      return { label: 'Recording', tone: 'live', action: null }
    case 'transcribing': {
      const p = m.progress
      if (p?.wait) return { label: p.wait, tone: 'busy', action: null }
      return { label: p && p.total ? `Transcribing ${p.done}/${p.total}` : 'Transcribing', tone: 'busy', action: null }
    }
    case 'matching':
      return { label: 'Matching', tone: 'busy', action: null }
    case 'done':
      return { label: 'Done', tone: 'done', action: null }
    case 'failed':
      return { label: 'Failed', tone: 'failed', action: m.error?.startsWith(MATCH_FAILED) ? 'rematch' : 'retry' }
  }
}

// ── Dates (local time) ───────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0')

/** A local day as YYYY-MM-DD (also an <input type="date">'s value). */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** Local midnight of the day ms is in. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Local midnight of a YYYY-MM-DD; null when it is not one. */
export function dayStart(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return dayKey(d.getTime()) === key ? d.getTime() : null
}

/** The midnight after a day (days are not always 24 hours long: daylight saving). */
const nextDay = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

export interface CalendarDay {
  key: string
  day: number
  start: number
  inMonth: boolean
}

/** A month as six weeks of days, Monday first; the days around it fill the first and last week. */
export function monthGrid(year: number, month: number): CalendarDay[] {
  const first = new Date(year, month, 1)
  const lead = (first.getDay() + 6) % 7
  const out: CalendarDay[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - lead + i)
    out.push({ key: dayKey(d.getTime()), day: d.getDate(), start: d.getTime(), inMonth: d.getMonth() === month })
  }
  return out
}

/** The span a month grid shows, for the list call that marks its days. */
export function gridRange(year: number, month: number): Range {
  const g = monthGrid(year, month)
  return { from: g[0]!.start, to: nextDay(g[g.length - 1]!.start) }
}

/** The days with a meeting (calendar marks): how many on each. */
export function markedDays(rows: Pick<MeetingRow, 'started'>[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const k = dayKey(r.started)
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

/** [from, to): a meeting is in it when it started in it. */
export interface Range {
  from: number
  to: number
}
export const RANGE_PRESETS = ['today', 'week', '30d', 'custom'] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]
export const PRESET_LABELS: Record<RangePreset, string> = { today: 'Today', week: 'This week', '30d': 'Last 30 days', custom: 'Custom' }

/** Today; this week (from Monday); the last 30 days (today and the 29 before). All end at tonight's midnight. */
export function presetRange(p: Exclude<RangePreset, 'custom'>, now: number): Range {
  const today = startOfDay(now)
  const to = nextDay(today)
  if (p === 'today') return { from: today, to }
  const d = new Date(today)
  if (p === 'week') return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime(), to }
  return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29).getTime(), to }
}

/** A custom From / To (both days count); swapped when the To is before the From; null when either is not a day. */
export function customRange(fromKey: string, toKey: string): Range | null {
  const a = dayStart(fromKey)
  const b = dayStart(toKey)
  if (a === null || b === null) return null
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return { from: lo, to: nextDay(hi) }
}

/** The range's last day (the To shown for a range that ends at a midnight). */
export const lastDayKey = (r: Range): string => dayKey(r.to - 1)

// ── The transcript ───────────────────────────────────────────────────────────

/** m:ss, or h:mm:ss past an hour. */
export const lineClock = (ms: number): string => recordClock(ms)

/** The line playing at ms: the last that started at or before it; -1 before the first. Segments are sorted by start. */
export function lineAt(segments: Pick<Segment, 'start'>[], ms: number): number {
  let lo = 0
  let hi = segments.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid]!.start <= ms) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

const fold = (s: string) => s.toLocaleLowerCase()

/** The lines whose text has the query (any case); none for a blank query. */
export function searchLines(segments: Pick<Segment, 'text'>[], query: string): number[] {
  const q = fold(query.trim())
  if (!q) return []
  const out: number[] = []
  segments.forEach((s, i) => fold(s.text).includes(q) && out.push(i))
  return out
}

/** A line's text cut where the query is, so the hits can be marked (React elements only, no HTML). */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const q = fold(query.trim())
  if (!q) return [{ text, hit: false }]
  const low = fold(text)
  const out: { text: string; hit: boolean }[] = []
  let i = 0
  // Lower-casing keeps the length for the scripts a transcript is in; where it would not, no marks.
  if (low.length !== text.length) return [{ text, hit: false }]
  for (let j = low.indexOf(q); j !== -1; j = low.indexOf(q, i)) {
    if (j > i) out.push({ text: text.slice(i, j), hit: false })
    out.push({ text: text.slice(j, j + q.length), hit: true })
    i = j + q.length
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false })
  return out
}

/** The next (↓, +1) or previous (↑, -1) hit from the current one, wrapping around. */
export function stepHit(count: number, current: number, dir: 1 | -1): number {
  if (!count) return -1
  if (current < 0) return dir === 1 ? 0 : count - 1
  return (current + dir + count) % count
}

/** Per line, the matches that name it (the chips on matched lines). */
export function lineMatches(m: Pick<Meeting, 'matches'>): Map<number, { label: string; noteId: string | null }[]> {
  const out = new Map<number, { label: string; noteId: string | null }[]>()
  for (const x of m.matches) for (const i of x.segments) out.set(i, [...(out.get(i) ?? []), { label: x.label, noteId: x.noteId }])
  return out
}

/** The playback rates offered. */
export const RATES = [1, 1.5, 2] as const

// ── Export ───────────────────────────────────────────────────────────────────

const speakerName = (s: Segment['speaker']) => (s === 'you' ? 'You' : 'Others')

/** The meeting as Markdown: title, date and length, the summary, the whole transcript. */
export function meetingMarkdown(m: Meeting): string {
  const out = [`# ${meetingTitle(m)}`, `${meetingWhen(m.started)} · ${lineClock(meetingLengthMs(m, m.ended ?? m.started))}`]
  if (m.summary) out.push('## Summary', m.summary)
  out.push('## Transcript')
  out.push(m.segments.length ? m.segments.map((s) => `**${speakerName(s.speaker)}** ${lineClock(s.start)}  ${s.text}`).join('\n\n') : '_No transcript._')
  if (m.micLog?.length) out.push('## Mic log', `_${MIC_LOG_CLOCK}_`, micLogLines(m).map((l) => `- ${l}`).join('\n'))
  return `${out.join('\n\n')}\n`
}

const MIC_STATE: Record<MicLogEntry['state'], string> = { muted: 'Muted', unmuted: 'Unmuted', unknown: 'Unknown' }
const MIC_WHY: Record<MuteWhy, string> = {
  found: 'button found',
  'not-running': 'not running',
  'not-trusted': 'no Accessibility for the helper',
  'no-control': 'no mute button found',
  cut: 'search cut short',
  error: 'the app did not answer',
}
const MIC_REASON: Record<MicUnknown, string> = {
  'not-trusted': 'no Accessibility',
  'no-helper': 'mute reader missing',
  'helper-ended': 'mute reader stopped',
  'no-app': 'no meeting app found',
  unreadable: "can't see the mute",
}

/** One line of a meeting's Mic log (the Meetings page, the Markdown export): "0:12 · Muted · Zoom · button found · mic out". */
export function micLogLine(e: MicLogEntry): string {
  const parts = [lineClock(e.t), e.paused ? 'Paused' : MIC_STATE[e.state]]
  if (e.app) parts.push(e.app)
  if (e.why) parts.push(MIC_WHY[e.why])
  if (e.reason) parts.push(MIC_REASON[e.reason])
  parts.push(e.gated ? 'mic out' : 'mic recorded')
  return parts.join(' · ')
}

/**
 * What the Mic log's times are: wall clock from the press of Record (a pause counts), unlike the
 * transcript's, which leave pauses out.
 */
export const MIC_LOG_CLOCK = 'Times are wall clock since Record.'

/**
 * A meeting's Mic log as lines: the kept entries, with "n changes not kept" where the ones between
 * the first and the last MIC_LOG_KEEP were left out.
 */
export function micLogLines(m: Pick<Meeting, 'micLog' | 'micLogDropped'>): string[] {
  const lines = (m.micLog ?? []).map(micLogLine)
  if (m.micLogDropped) lines.splice(MIC_LOG_KEEP, 0, `${m.micLogDropped} ${m.micLogDropped === 1 ? 'change' : 'changes'} not kept`)
  return lines
}

/** A file name for an export: the title with only safe characters, and the date. */
export function exportName(m: Pick<Meeting, 'title' | 'started'>, kind: ExportKind): string {
  // Letters, digits, spaces, _ and - only: no dots, slashes or anything a file system reads.
  const base = m.title.replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim() || 'Meeting'
  return `${base} ${dayKey(m.started)}.${kind === 'md' ? 'md' : 'webm'}`
}
