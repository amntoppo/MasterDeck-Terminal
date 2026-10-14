import { describe, expect, it } from 'vitest'
import {
  audioExpired,
  cleanRequest,
  CLEAN_MAX,
  DAY_MS,
  janitorRows,
  janitorTotals,
  needsTypedCount,
  pickOlder,
  sizeLabel,
  type JanitorMeetingRow,
} from './meetingJanitor'

const id = (n: number) => `m-${n.toString(16).padStart(32, '0')}`
const NOW = 1_000 * DAY_MS
const row = (n: number, daysAgo: number, audio = 100, over: Partial<JanitorMeetingRow> = {}): JanitorMeetingRow => ({
  id: id(n),
  title: `M${n}`,
  started: NOW - daysAgo * DAY_MS,
  audioBytes: audio,
  transcriptBytes: 10,
  recording: false,
  ...over,
})

describe('janitorRows', () => {
  it('maps the store sizes and marks the one being recorded', () => {
    const rows = janitorRows(
      [
        { id: id(1), title: 'A', started: 5, audio: 7, transcript: 3 },
        { id: id(2), title: '', started: 6, audio: 0, transcript: 4 },
      ],
      id(2),
    )
    expect(rows).toEqual([
      { id: id(1), title: 'A', started: 5, audioBytes: 7, transcriptBytes: 3, recording: false },
      { id: id(2), title: '', started: 6, audioBytes: 0, transcriptBytes: 4, recording: true },
    ])
  })
})

describe('pickOlder', () => {
  it('picks meetings older than the days, never one being recorded', () => {
    const rows = [row(1, 3), row(2, 8), row(3, 31), row(4, 100), row(5, 200, 100, { recording: true })]
    expect(pickOlder(rows, 7, NOW)).toEqual([id(2), id(3), id(4)])
    expect(pickOlder(rows, 30, NOW)).toEqual([id(3), id(4)])
    expect(pickOlder(rows, 90, NOW)).toEqual([id(4)])
    // Exactly 7 days old is not older than 7 days.
    expect(pickOlder([row(6, 7)], 7, NOW)).toEqual([])
  })
})

describe('janitorTotals', () => {
  it('sums every row, or the picked ones', () => {
    const rows = [row(1, 1, 100), row(2, 2, 50)]
    expect(janitorTotals(rows)).toEqual({ meetings: 2, audioBytes: 150, transcriptBytes: 20 })
    expect(janitorTotals(rows, [id(2)])).toEqual({ meetings: 1, audioBytes: 50, transcriptBytes: 10 })
    expect(janitorTotals([])).toEqual({ meetings: 0, audioBytes: 0, transcriptBytes: 0 })
  })
})

describe('needsTypedCount', () => {
  it('over 10 at once', () => {
    expect(needsTypedCount(10)).toBe(false)
    expect(needsTypedCount(11)).toBe(true)
  })
})

describe('cleanRequest', () => {
  it('takes meeting ids and audio or meetings; anything else is no request', () => {
    expect(cleanRequest({ ids: [id(1), id(1), id(2)], what: 'audio' })).toEqual({ ids: [id(1), id(2)], what: 'audio' })
    expect(cleanRequest({ ids: [id(1)], what: 'meetings' })).toEqual({ ids: [id(1)], what: 'meetings' })
    for (const bad of [
      null,
      [],
      'x',
      { ids: [id(1)], what: 'notes' },
      { ids: [], what: 'audio' },
      { ids: ['../etc'], what: 'audio' },
      { ids: [id(1), 3], what: 'audio' },
      { ids: id(1), what: 'audio' },
      { ids: Array.from({ length: CLEAN_MAX + 1 }, (_, i) => id(i)), what: 'audio' },
    ])
      expect(cleanRequest(bad)).toBeNull()
  })
})

describe('audioExpired', () => {
  it('older meetings that still have audio; none when the setting is never', () => {
    const rows = [row(1, 10), row(2, 40), row(3, 40, 0), row(4, 40, 100, { recording: true })]
    expect(audioExpired(rows, 30, NOW)).toEqual([id(2)])
    expect(audioExpired(rows, null, NOW)).toEqual([])
    expect(audioExpired(rows, 7, NOW)).toEqual([id(1), id(2)])
  })
})

describe('sizeLabel', () => {
  it('bytes in plain units', () => {
    expect(sizeLabel(0)).toBe('0 B')
    expect(sizeLabel(2048)).toBe('2 KB')
    expect(sizeLabel(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(sizeLabel(3 * 1024 ** 3)).toBe('3.00 GB')
  })
})
