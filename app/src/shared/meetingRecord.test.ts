import { describe, expect, it } from 'vitest'
import {
  asCaptureEnd,
  CHUNK_MAX_BYTES,
  CHUNK_SAMPLES,
  cleanTitle,
  MEETING_LANGUAGES,
  MEETING_TITLE_MAX,
  mergeSegments,
  oneAtATime,
  normalizeMeetings,
  recordClock,
  recordedMs,
  storedMeeting,
  type Meeting,
  type Segment,
} from './meetings'
import { CaptureControl, checkWav, Chunker, Resampler, rms, toInt16, wav, WAV_HEADER } from './meetingAudio'

const ID = 'm-' + 'a'.repeat(32)
const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: ID,
  title: 'Planning with acme',
  titleBy: 'user',
  started: 1000,
  ended: 5000,
  pausedMs: 0,
  apps: [],
  state: 'transcribing',
  model: 'base',
  language: 'auto',
  segments: [{ start: 0, end: 900, speaker: 'you', text: 'Hello alice' }],
  summary: null,
  matches: [{ label: 'acme/web#3', noteId: 'n-1', segments: [0] }],
  progress: { done: 1, total: 2, wait: null },
  error: null,
  ...over,
})

describe('storedMeeting', () => {
  it('reads a meeting MasterDeck wrote and round-trips it', () => {
    const m = meeting()
    expect(storedMeeting(JSON.parse(JSON.stringify(m)), ID)).toEqual(m)
    expect(storedMeeting(meeting({ ended: null, state: 'recording', titleBy: null, title: '' }), ID)).not.toBeNull()
    // Files from before progress: read as none.
    const { progress: _, ...old } = m
    expect(storedMeeting(old, ID)).toEqual({ ...m, progress: null })
  })

  it('anything else is not a meeting (and so never overwritten)', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      { ...meeting(), id: 'm-' + 'b'.repeat(32) },
      { ...meeting(), id: '../etc' },
      { ...meeting(), state: 'paused' },
      { ...meeting(), title: 'a\nb' },
      { ...meeting(), title: ' padded ' },
      { ...meeting(), title: 'x'.repeat(MEETING_TITLE_MAX + 1) },
      { ...meeting(), ended: 10 },
      { ...meeting(), pausedMs: -1 },
      { ...meeting(), language: 'english' },
      { ...meeting(), model: '../model' },
      { ...meeting(), segments: [{ start: 5, end: 1, speaker: 'you', text: '' }] },
      { ...meeting(), segments: [{ start: 0, end: 1, speaker: 'bob', text: '' }] },
      { ...meeting(), segments: [{ start: 0, end: 1, speaker: 'you', text: 'a\u0007' }] },
      { ...meeting(), matches: [{ label: 'x', noteId: null, segments: [3] }] },
      { ...meeting(), matches: [{ label: 'x', noteId: '../n', segments: [] }] },
      { ...meeting(), error: 5 },
      { ...meeting(), apps: 'zoom' },
      { ...meeting(), progress: { done: -1, total: 2, wait: null } },
      { ...meeting(), progress: { done: 1, total: 2, wait: 'a\nb' } },
      { ...meeting(), progress: { done: 1, total: 2 } },
    ]
    for (const b of bad) expect(storedMeeting(b, ID), JSON.stringify(b)).toBeNull()
    expect(storedMeeting({ ...meeting(), id: '../etc' }, '../etc')).toBeNull()
  })
})

describe('cleanTitle', () => {
  it('trims, allows none, refuses lines, control characters and long titles', () => {
    expect(cleanTitle(undefined)).toBe('')
    expect(cleanTitle('  Standup ')).toBe('Standup')
    expect(cleanTitle('a\nb')).toBeNull()
    expect(cleanTitle(5)).toBeNull()
    expect(cleanTitle('x'.repeat(MEETING_TITLE_MAX + 1))).toBeNull()
  })
})

describe('mergeSegments', () => {
  it('orders both tracks by start, keeps overlaps, sets the speaker, you first on a tie', () => {
    const you: Segment[] = [
      { start: 0, end: 4000, speaker: 'others', text: 'a' },
      { start: 9000, end: 9500, speaker: 'you', text: 'c' },
    ]
    const others: Segment[] = [
      { start: 0, end: 1000, speaker: 'you', text: 'b' },
      { start: 2000, end: 3000, speaker: 'others', text: 'overlap' },
    ]
    expect(mergeSegments(you, others).map((s) => `${s.speaker}:${s.text}`)).toEqual(['you:a', 'others:b', 'others:overlap', 'you:c'])
  })
})

describe('languages', () => {
  it('every listed language is one Settings stores', () => {
    for (const [code] of MEETING_LANGUAGES) expect(normalizeMeetings({ language: code }).language).toBe(code)
  })
})

describe('asCaptureEnd', () => {
  it('a known reason, else error', () => {
    expect(asCaptureEnd('stopped')).toBe('stopped')
    expect(asCaptureEnd('<b>x</b>')).toBe('error')
  })
})

describe('the capture window’s audio', () => {
  it('wav writes a header checkWav accepts; anything else is refused', () => {
    const w = wav(new Int16Array([1, -1, 32767, -32768]))
    expect(w.length).toBe(WAV_HEADER + 8)
    expect(checkWav(w)).toBe(true)
    expect(new DataView(w.buffer).getInt16(WAV_HEADER + 4, true)).toBe(32767)
    expect(checkWav(wav(new Int16Array(4), 48000))).toBe(false)
    expect(checkWav(w.slice(0, 50))).toBe(false)
    const wrong = w.slice()
    wrong[0] = 0x58
    expect(checkWav(wrong)).toBe(false)
    expect(checkWav(new Uint8Array(10))).toBe(false)
    // A full 30-second chunk fits the limit.
    const full = wav(new Int16Array(CHUNK_SAMPLES))
    expect(full.length).toBeLessThanOrEqual(CHUNK_MAX_BYTES)
    expect(checkWav(full)).toBe(true)
  })

  it('toInt16 clips and scales', () => {
    expect([...toInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))]).toEqual([0, 32767, -32768, 32767, -32768, 16384])
  })

  it('rms', () => {
    expect(rms(new Float32Array(0))).toBe(0)
    expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5)
  })

  it('Resampler: 48 kHz to 16 kHz keeps every third sample and joins blocks', () => {
    const r = new Resampler(48000)
    const ramp = Float32Array.from({ length: 12 }, (_, i) => i)
    const all = [...r.push(ramp.subarray(0, 5)), ...r.push(ramp.subarray(5, 7)), ...r.push(ramp.subarray(7))]
    expect(all).toEqual([0, 3, 6, 9])
    expect([...new Resampler(16000).push(Float32Array.from([1, 2]))]).toEqual([1, 2])
  })

  it('Resampler: 44.1 kHz gives the right count over a second', () => {
    const r = new Resampler(44100)
    let n = 0
    for (let b = 0; b < 441; b++) n += r.push(new Float32Array(100)).length
    expect(Math.abs(n - 16000)).toBeLessThanOrEqual(2)
  })

  it('Chunker: full chunks in order, the rest on flush', () => {
    const c = new Chunker(4)
    expect(c.push(Int16Array.from([1, 2, 3]))).toEqual([])
    const full = c.push(Int16Array.from([4, 5, 6, 7, 8, 9, 10]))
    expect(full.map((f) => [f.seq, [...f.samples]])).toEqual([
      [0, [1, 2, 3, 4]],
      [1, [5, 6, 7, 8]],
    ])
    const rest = c.flush()
    expect(rest && [rest.seq, [...rest.samples]]).toEqual([2, [9, 10]])
    expect(c.flush()).toBeNull()
  })
})

describe('the rail’s time', () => {
  it('recordClock', () => {
    expect(recordClock(0)).toBe('0:00')
    expect(recordClock(65_400)).toBe('1:05')
    expect(recordClock(3_723_000)).toBe('1:02:03')
  })
  it('recordedMs runs from since, and is frozen while paused', () => {
    expect(recordedMs({ recording: true, since: 1000, paused: false, elapsed: 0, offer: null }, 6000)).toBe(5000)
    expect(recordedMs({ recording: true, since: 1000, paused: true, elapsed: 4000, offer: null }, 99_000)).toBe(4000)
  })
})

describe('CaptureControl (the capture page keeps pause and stop until its streams open)', () => {
  it('keeps the last pause state and a stop, then hands each later command on', () => {
    const c = new CaptureControl()
    c.take('pause')
    c.take('resume')
    c.take('pause')
    expect(c).toMatchObject({ paused: true, stopped: false })
    const seen: string[] = []
    c.attach((x) => seen.push(x))
    c.take('resume')
    c.take('stop')
    expect(seen).toEqual(['resume', 'stop'])
    expect(c).toMatchObject({ paused: false, stopped: true })
  })
})

describe('oneAtATime', () => {
  it('shares one pending call, and calls again once it is done', async () => {
    let calls = 0
    let answer = (_v: boolean) => {}
    const ask = oneAtATime(async (what: string) => {
      calls++
      return new Promise<boolean>((res) => (answer = (v) => res(v && what === 'quit')))
    })
    const a = ask('quit')
    const b = ask('restart')
    expect(a).toBe(b)
    answer(true)
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(calls).toBe(1)
    const c = ask('restart')
    answer(true)
    expect(await c).toBe(false)
    expect(calls).toBe(2)
  })

  it('a failed call frees the next one', async () => {
    let n = 0
    const f = oneAtATime(async () => {
      if (n++ === 0) throw new Error('no')
      return n
    })
    await expect(f()).rejects.toThrow('no')
    expect(await f()).toBe(2)
  })
})
