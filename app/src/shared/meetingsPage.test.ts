import { describe, expect, it } from 'vitest'
import { MIC_LOG_KEEP, MIC_LOG_MAX, type Meeting } from './meetings'
import {
  customRange,
  dayKey,
  dayStart,
  exportName,
  gridRange,
  highlightParts,
  lastDayKey,
  lineAt,
  lineMatches,
  markedDays,
  meetingAudioUrl,
  meetingLengthMs,
  meetingMarkdown,
  meetingRow,
  meetingTitle,
  micLogLine,
  micLogLines,
  monthGrid,
  presetRange,
  searchLines,
  stateView,
  stepHit,
} from './meetingsPage'

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime()

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 'm-' + 'a'.repeat(32),
  title: 'Acme standup',
  titleBy: 'user',
  started: at(2026, 9, 9, 10),
  ended: at(2026, 9, 9, 10, 30),
  pausedMs: 5 * 60_000,
  apps: [],
  state: 'done',
  model: 'base',
  language: 'en',
  segments: [
    { start: 0, end: 900, speaker: 'you', text: 'Morning, Alice.' },
    { start: 1000, end: 1900, speaker: 'others', text: 'The LOGIN fix is ready; login works.' },
    { start: 65_000, end: 66_000, speaker: 'you', text: 'Ship it.' },
  ],
  summary: 'The login fix is ready.',
  matches: [
    { label: 'acme/web#42', noteId: 'n-' + 'b'.repeat(32), segments: [1, 2] },
    { label: 'acme/api#7', noteId: null, segments: [1] },
  ],
  progress: null,
  error: null,
  ...over,
})

describe('the list', () => {
  it('a row has no transcript and counts the notes added', () => {
    const r = meetingRow(meeting())
    expect(r).not.toHaveProperty('segments')
    expect(r.notes).toBe(1)
  })

  it('length leaves the paused time out; a recording runs to now', () => {
    const m = meeting()
    expect(meetingLengthMs(m, 0)).toBe(25 * 60_000)
    expect(meetingLengthMs({ ...m, ended: null }, m.started + 60_000)).toBe(0)
    expect(meetingLengthMs({ ...m, ended: null, pausedMs: 0 }, m.started + 60_000)).toBe(60_000)
  })

  it('an unnamed meeting is named by its date', () => {
    expect(meetingTitle({ title: '', started: at(2026, 9, 9, 10, 5) })).toBe('Meeting 2026-10-09 10:05')
    expect(meetingTitle({ title: 'Acme', started: 0 })).toBe('Acme')
  })

  it('states: recording, transcribing d/t, waiting, matching, done, failed with the right action', () => {
    expect(stateView({ state: 'recording', progress: null, error: null }).label).toBe('Recording')
    expect(stateView({ state: 'transcribing', progress: { done: 3, total: 12, wait: null }, error: null }).label).toBe('Transcribing 3/12')
    expect(stateView({ state: 'transcribing', progress: null, error: null }).label).toBe('Transcribing')
    expect(stateView({ state: 'transcribing', progress: { done: 0, total: 4, wait: 'Waiting for the speech model' }, error: null }).label).toBe('Waiting for the speech model')
    expect(stateView({ state: 'matching', progress: null, error: null }).label).toBe('Matching')
    expect(stateView({ state: 'done', progress: null, error: null })).toEqual({ label: 'Done', tone: 'done', action: null })
    expect(stateView({ state: 'failed', progress: null, error: 'Transcription failed: x' }).action).toBe('retry')
    expect(stateView({ state: 'failed', progress: null, error: 'Could not match: no answer' }).action).toBe('rematch')
  })

  it('the audio URL is the one shape the scheme serves', () => {
    expect(meetingAudioUrl('m-' + 'a'.repeat(32))).toBe(`masterdeck-media://meeting/m-${'a'.repeat(32)}/audio`)
  })
})

describe('the calendar', () => {
  it('a month is six weeks from a Monday, the days around it marked out', () => {
    // October 2026 starts on a Thursday.
    const g = monthGrid(2026, 9)
    expect(g).toHaveLength(42)
    expect(g[0]).toMatchObject({ key: '2026-09-28', day: 28, inMonth: false })
    expect(new Date(g[0]!.start).getDay()).toBe(1)
    expect(g[3]).toMatchObject({ key: '2026-10-01', inMonth: true })
    expect(g.filter((d) => d.inMonth)).toHaveLength(31)
    const r = gridRange(2026, 9)
    expect(dayKey(r.from)).toBe('2026-09-28')
    expect(dayKey(r.to)).toBe('2026-11-09')
  })

  it('marks count the meetings of each day, in local time', () => {
    const marks = markedDays([{ started: at(2026, 9, 9, 0, 1) }, { started: at(2026, 9, 9, 23, 59) }, { started: at(2026, 9, 12, 12) }])
    expect([...marks]).toEqual([
      ['2026-10-09', 2],
      ['2026-10-12', 1],
    ])
  })

  it('day keys round-trip; a day that does not exist is none', () => {
    expect(dayStart('2026-10-09')).toBe(at(2026, 9, 9))
    expect(dayStart('2026-02-30')).toBeNull()
    expect(dayStart('yesterday')).toBeNull()
  })
})

describe('ranges', () => {
  const now = at(2026, 9, 10, 15, 30) // a Saturday

  it('Today, This week (from Monday), Last 30 days all end at tonight’s midnight', () => {
    expect(presetRange('today', now)).toEqual({ from: at(2026, 9, 10), to: at(2026, 9, 11) })
    expect(presetRange('week', now)).toEqual({ from: at(2026, 9, 5), to: at(2026, 9, 11) })
    expect(presetRange('30d', now)).toEqual({ from: at(2026, 8, 11), to: at(2026, 9, 11) })
    // A Monday's week starts that day; a Sunday's the Monday before.
    expect(presetRange('week', at(2026, 9, 5, 9)).from).toBe(at(2026, 9, 5))
    expect(presetRange('week', at(2026, 9, 11, 9)).from).toBe(at(2026, 9, 5))
  })

  it('Custom: both days count, a reversed pair is swapped, a bad day is none', () => {
    const r = customRange('2026-10-03', '2026-10-01')!
    expect(r).toEqual({ from: at(2026, 9, 1), to: at(2026, 9, 4) })
    expect(lastDayKey(r)).toBe('2026-10-03')
    expect(customRange('2026-10-09', '2026-10-09')).toEqual({ from: at(2026, 9, 9), to: at(2026, 9, 10) })
    expect(customRange('', '2026-10-09')).toBeNull()
  })
})

describe('the transcript', () => {
  const segs = meeting().segments

  it('the playing line is the last that started at or before the time', () => {
    expect(lineAt(segs, -1)).toBe(-1)
    expect(lineAt(segs, 0)).toBe(0)
    expect(lineAt(segs, 999)).toBe(0)
    expect(lineAt(segs, 1000)).toBe(1)
    expect(lineAt(segs, 30_000)).toBe(1)
    expect(lineAt(segs, 10_000_000)).toBe(2)
    expect(lineAt([], 5)).toBe(-1)
  })

  it('search finds lines in any case; a blank query finds none', () => {
    expect(searchLines(segs, 'login')).toEqual([1])
    expect(searchLines(segs, '  i')).toEqual([0, 1, 2])
    expect(searchLines(segs, '   ')).toEqual([])
  })

  it('highlights cut the text at every hit, keeping its case', () => {
    expect(highlightParts('The LOGIN fix; login works.', 'login')).toEqual([
      { text: 'The ', hit: false },
      { text: 'LOGIN', hit: true },
      { text: ' fix; ', hit: false },
      { text: 'login', hit: true },
      { text: ' works.', hit: false },
    ])
    expect(highlightParts('abc', '')).toEqual([{ text: 'abc', hit: false }])
  })

  it('↑/↓ step through the hits and wrap', () => {
    expect(stepHit(0, -1, 1)).toBe(-1)
    expect(stepHit(3, -1, 1)).toBe(0)
    expect(stepHit(3, -1, -1)).toBe(2)
    expect(stepHit(3, 2, 1)).toBe(0)
    expect(stepHit(3, 0, -1)).toBe(2)
  })

  it('chips: each line knows the matches that name it', () => {
    const c = lineMatches(meeting())
    expect(c.get(0)).toBeUndefined()
    expect(c.get(1)?.map((x) => x.label)).toEqual(['acme/web#42', 'acme/api#7'])
    expect(c.get(2)).toEqual([{ label: 'acme/web#42', noteId: 'n-' + 'b'.repeat(32) }])
  })
})

describe('export', () => {
  it('Markdown: title, date and length, summary, every line with speaker and time', () => {
    const md = meetingMarkdown(meeting())
    expect(md).toContain('# Acme standup')
    expect(md).toContain('2026-10-09 10:00 · 25:00')
    expect(md).toContain('## Summary\n\nThe login fix is ready.')
    expect(md).toContain('**You** 0:00  Morning, Alice.')
    expect(md).toContain('**You** 1:05  Ship it.')
  })

  it('the Mic log: the changes not kept are said where they fell', () => {
    const e = { t: 0, state: 'muted' as const, app: 'Zoom', gated: true }
    const log = Array.from({ length: MIC_LOG_MAX }, (_, i) => ({ ...e, t: i * 1000 }))
    const lines = micLogLines({ micLog: log, micLogDropped: 7 })
    expect(lines).toHaveLength(MIC_LOG_MAX + 1)
    expect(lines[MIC_LOG_KEEP]).toBe('7 changes not kept')
    expect(lines[MIC_LOG_KEEP - 1]).toBe(micLogLine(log[MIC_LOG_KEEP - 1]))
    expect(micLogLines({ micLog: log, micLogDropped: 1 })[MIC_LOG_KEEP]).toBe('1 change not kept')
    expect(micLogLines({ micLog: log.slice(0, 3) })).toEqual(log.slice(0, 3).map(micLogLine))
    expect(meetingMarkdown(meeting({ micLog: log, micLogDropped: 7 }))).toContain('- 7 changes not kept\n')
  })

  it('the Mic log: one line per change, in the export only when there is one', () => {
    expect(micLogLine({ t: 12_000, state: 'muted', app: 'Google Meet', why: 'found', gated: true })).toBe('0:12 · Muted · Google Meet · button found · mic out')
    expect(micLogLine({ t: 0, state: 'unknown', app: null, reason: 'not-trusted', gated: false })).toBe('0:00 · Unknown · no Accessibility · mic recorded')
    expect(micLogLine({ t: 65_000, state: 'unknown', app: 'Google Meet', why: 'no-control', reason: 'unreadable', gated: false })).toBe(
      "1:05 · Unknown · Google Meet · no mute button found · can't see the mute · mic recorded",
    )
    expect(micLogLine({ t: 1000, state: 'unknown', app: 'Zoom', gated: true, paused: true })).toBe('0:01 · Paused · Zoom · mic out')
    expect(meetingMarkdown(meeting())).not.toContain('Mic log')
    const md = meetingMarkdown(meeting({ micLog: [{ t: 12_000, state: 'muted', app: 'Zoom', why: 'found', gated: true }] }))
    expect(md).toContain('## Mic log\n\n_Times are wall clock since Record._\n\n- 0:12 · Muted · Zoom · button found · mic out\n')
  })

  it('file names keep only safe characters', () => {
    expect(exportName(meeting({ title: '../../etc/passwd: notes' }), 'md')).toBe('etc passwd notes 2026-10-09.md')
    expect(exportName(meeting({ title: '' }), 'audio')).toBe('Meeting 2026-10-09.webm')
    expect(exportName(meeting({ title: 'Café sync' }), 'audio')).toBe('Café sync 2026-10-09.webm')
  })
})
