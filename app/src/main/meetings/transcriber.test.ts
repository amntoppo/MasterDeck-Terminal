import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_MS, type Meeting, type Speaker } from '@shared/meetings'
import { MeetingStore } from './store'
import { chunkSegments, Transcriber, WAIT_MODEL, type TranscriberDeps } from './transcriber'
import type { Segment as HeardSegment, TranscribeOptions } from './whisper'

let dir: string
let store: MeetingStore
let clock: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-transcriber-'))
  clock = 1_000_000
  store = new MeetingStore(dir, () => clock++)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (over: Partial<Meeting> = {}): Meeting => {
  const r = store.create({ title: '', titleBy: null, model: 'base', language: 'en' })
  if (!r.ok) throw new Error(r.message)
  if (!Object.keys(over).length) return r.meeting
  const u = store.update(r.meeting.id, (m) => ({ ...m, ...over }))
  if (!u.ok) throw new Error(u.message)
  return u.meeting
}
const chunk = (id: string, track: Speaker, seq: number) => {
  const w = store.writeChunk(id, track, seq, new Uint8Array([1, 2, 3]))
  if (!w.ok) throw new Error(w.message)
  return { id, track, seq }
}
const onDisk = (id: string, track: Speaker, seq: number) => existsSync(store.chunkPath(id, track, seq)!)
/** What the recorder does at Stop: the meeting goes on to transcription. */
const endRecording = (id: string) => store.update(id, (m) => ({ ...m, ended: clock, state: 'transcribing' }))

/** A whisper that hears the chunk's name, 100 to 900 ms in; `fail` names chunks that fail once. */
function fakeWhisper() {
  const calls: string[] = []
  const fail = new Set<string>()
  let running = 0
  let most = 0
  const transcribe = vi.fn(async (o: TranscribeOptions): Promise<HeardSegment[]> => {
    const name = basename(o.wav, '.wav')
    calls.push(name)
    running++
    most = Math.max(most, running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    if (fail.delete(name)) throw new Error(`whisper-cli failed (1): bad\u0007 audio in ${join(homedir(), 'chunk')}`)
    return [{ start: 100, end: 900, text: `${name} said ${o.language}` }]
  })
  return { calls, fail, transcribe, most: () => most }
}

function queue(over: Partial<TranscriberDeps> & { live?: () => string | null } = {}) {
  const w = fakeWhisper()
  let model: string | null = '/models/ggml-base.bin'
  const t = new Transcriber({
    store,
    modelPath: () => model,
    engine: () => '/acme/whisper-cli',
    transcribe: w.transcribe,
    live: () => null,
    now: () => clock,
    ...over,
  })
  return { t, w, setModel: (m: string | null) => (model = m) }
}

describe('chunkSegments', () => {
  it('adds the chunk offset and the speaker; control characters go, empty lines are dropped', () => {
    expect(chunkSegments([{ start: 10, end: 20, text: 'a\u0085b' }, { start: 30, end: 40, text: ' \u0007 ' }], 'others', 2)).toEqual([
      { start: 2 * CHUNK_MS + 10, end: 2 * CHUNK_MS + 20, speaker: 'others', text: 'a b' },
    ])
  })

  it('a start stays inside its chunk, and an end is never before its start', () => {
    expect(chunkSegments([{ start: CHUNK_MS + 50, end: CHUNK_MS + 90, text: 'late' }, { start: 500, end: 200, text: 'back' }], 'you', 1)).toEqual([
      { start: 2 * CHUNK_MS - 1, end: 2 * CHUNK_MS + 90, speaker: 'you', text: 'late' },
      { start: CHUNK_MS + 500, end: CHUNK_MS + 500, speaker: 'you', text: 'back' },
    ])
  })
})

describe('Transcriber', () => {
  it('one chunk at a time, in the order they closed; offsets and speakers; WAVs removed; finished after the end', async () => {
    const m = make()
    let live: string | null = m.id
    const handed: string[] = []
    const { t, w } = queue({ live: () => live, onTranscribed: (id) => handed.push(id) })
    t.add(chunk(m.id, 'you', 0))
    t.add(chunk(m.id, 'others', 0))
    t.add(chunk(m.id, 'you', 1))
    t.add({ id: m.id, track: 'you', seq: 1 }) // once only
    await vi.waitFor(() => expect(store.get(m.id)?.progress).toEqual({ done: 3, total: 3, wait: null }))
    expect(w.calls).toEqual(['you-0', 'others-0', 'you-1'])
    expect(w.most()).toBe(1)
    // Still recording: not finished.
    expect(store.get(m.id)?.state).toBe('recording')
    expect([onDisk(m.id, 'you', 0), onDisk(m.id, 'others', 0), onDisk(m.id, 'you', 1)]).toEqual([false, false, false])
    live = null
    endRecording(m.id)
    t.ended(m.id)
    const done = store.get(m.id)!
    expect(done.state).toBe('matching')
    expect(handed).toEqual([m.id])
    expect(done.segments).toEqual([
      { start: 100, end: 900, speaker: 'you', text: 'you-0 said en' },
      { start: 100, end: 900, speaker: 'others', text: 'others-0 said en' },
      { start: CHUNK_MS + 100, end: CHUNK_MS + 900, speaker: 'you', text: 'you-1 said en' },
    ])
  })

  it('without a matcher the meeting is done', async () => {
    const m = make()
    const { t } = queue()
    t.add(chunk(m.id, 'you', 0))
    endRecording(m.id)
    t.ended(m.id)
    await vi.waitFor(() => expect(store.get(m.id)?.state).toBe('done'))
    expect(store.get(m.id)?.progress).toEqual({ done: 1, total: 1, wait: null })
  })

  it('a failed chunk stays; the meeting\'s other chunks go on; failed at the end; Try again reruns only what is on disk', async () => {
    const a = make()
    const b = make()
    const { t, w } = queue()
    w.fail.add('others-0')
    t.add(chunk(a.id, 'you', 0))
    t.add(chunk(a.id, 'others', 0))
    t.add(chunk(a.id, 'you', 1))
    t.add(chunk(b.id, 'you', 0))
    endRecording(a.id)
    endRecording(b.id)
    t.ended(a.id)
    t.ended(b.id)
    await vi.waitFor(() => expect(store.get(b.id)?.state).toBe('done'))
    const failed = store.get(a.id)!
    expect(failed.state).toBe('failed')
    // One line, no control character, no home folder.
    expect(failed.error).toBe('Transcription failed: whisper-cli failed (1): bad audio in ~/chunk')
    // The meeting's later chunk ran; only the failed one is still on disk.
    expect(w.calls).toEqual(['you-0', 'others-0', 'you-1', 'you-0'])
    expect([onDisk(a.id, 'you', 0), onDisk(a.id, 'others', 0), onDisk(a.id, 'you', 1)]).toEqual([false, true, false])
    expect(failed.segments.map((s) => s.text)).toEqual(['you-0 said en', 'you-1 said en'])

    expect(t.retry(b.id)).toMatchObject({ ok: false })
    expect(t.retry(a.id)).toEqual({ ok: true })
    expect(store.get(a.id)).toMatchObject({ state: 'transcribing', error: null })
    await vi.waitFor(() => expect(store.get(a.id)?.state).toBe('done'))
    expect(w.calls.slice(4)).toEqual(['others-0'])
    expect(store.get(a.id)!.segments.map((s) => s.text)).toEqual(['you-0 said en', 'others-0 said en', 'you-1 said en'])
    expect(store.get(a.id)!.progress).toEqual({ done: 3, total: 3, wait: null })
  })

  it('Try again on a meeting with nothing recorded is refused', () => {
    const m = make({ state: 'failed', ended: clock, error: 'Nothing was recorded.' })
    const { t } = queue()
    expect(t.retry(m.id)).toEqual({ ok: false, message: 'Nothing was recorded to transcribe.' })
    expect(t.retry('m-' + '0'.repeat(32))).toMatchObject({ ok: false })
  })

  it('no speech engine: failed with a plain reason', async () => {
    const m = make()
    const { t } = queue({ engine: () => null })
    t.add(chunk(m.id, 'you', 0))
    await vi.waitFor(() => expect(store.get(m.id)?.state).toBe('failed'))
    expect(store.get(m.id)?.error).toBe('The speech engine (whisper-cli) is missing.')
    expect(onDisk(m.id, 'you', 0)).toBe(true)
  })

  it('no speech model: waits in transcribing with a note, and goes on when one is ready', async () => {
    const m = make()
    const { t, w, setModel } = queue()
    setModel(null)
    t.add(chunk(m.id, 'you', 0))
    endRecording(m.id)
    t.ended(m.id)
    await vi.waitFor(() => expect(store.get(m.id)?.progress).toEqual({ done: 0, total: 1, wait: WAIT_MODEL }))
    expect(store.get(m.id)?.state).toBe('transcribing')
    t.add(chunk(m.id, 'others', 0))
    await new Promise((r) => setTimeout(r, 20))
    expect(w.calls).toEqual([])
    expect(store.get(m.id)?.progress).toEqual({ done: 0, total: 2, wait: WAIT_MODEL })
    setModel('/models/ggml-base.bin')
    t.modelReady()
    await vi.waitFor(() => expect(store.get(m.id)?.state).toBe('done'))
    expect(store.get(m.id)?.progress).toEqual({ done: 2, total: 2, wait: null })
  })

  it('at start: leftovers first, oldest meeting first; a crashed recording is transcribing; nothing recorded fails', async () => {
    const crashed = make() // state recording, never ended
    const waiting = make({ state: 'transcribing', ended: clock })
    const empty = make()
    const allText = make({ segments: [{ start: 0, end: 500, speaker: 'you', text: 'hi' }] })
    const live = make()
    chunk(crashed.id, 'you', 3)
    chunk(crashed.id, 'others', 3)
    chunk(waiting.id, 'others', 0)
    chunk(live.id, 'you', 0)
    const { t, w } = queue({ live: () => live.id })
    t.start()
    t.add(chunk(waiting.id, 'you', 1)) // a new chunk: after the leftovers
    await vi.waitFor(() => expect(store.get(waiting.id)?.state).toBe('done'))
    expect(w.calls).toEqual(['you-3', 'others-3', 'others-0', 'you-1'])
    const c = store.get(crashed.id)!
    expect(c.state).toBe('done')
    expect(c.ended).toBe(Math.min(clock, c.started + 4 * CHUNK_MS))
    expect(c.error).toMatch(/stopped while recording/)
    expect(c.segments[0]).toMatchObject({ start: 3 * CHUNK_MS + 100, speaker: 'you' })
    expect(store.get(empty.id)).toMatchObject({ state: 'failed', error: 'Nothing was recorded.' })
    expect(store.get(allText.id)?.state).toBe('done')
    // The meeting being recorded is left alone.
    expect(store.get(live.id)?.state).toBe('recording')
    expect(onDisk(live.id, 'you', 0)).toBe(true)
  })

  it('a meeting with no model waits; the chunks of meetings with one go past it', async () => {
    const a = make({ model: 'large' })
    const b = make({ model: 'large' })
    const c = make()
    let large: string | null = null
    const { t, w } = queue({ modelPath: (m) => (m.model === 'large' ? large : '/models/ggml-base.bin') })
    t.add(chunk(a.id, 'you', 0))
    t.add(chunk(b.id, 'you', 0))
    t.add(chunk(c.id, 'you', 0))
    for (const m of [a, b, c]) {
      endRecording(m.id)
      t.ended(m.id)
    }
    await vi.waitFor(() => expect(store.get(c.id)?.state).toBe('done'))
    expect(w.calls).toEqual(['you-0'])
    // Each waiting meeting says so.
    for (const m of [a, b]) expect(store.get(m.id)).toMatchObject({ state: 'transcribing', progress: { done: 0, total: 1, wait: WAIT_MODEL } })
    large = '/models/ggml-large.bin'
    t.modelReady()
    await vi.waitFor(() => expect([store.get(a.id)?.state, store.get(b.id)?.state]).toEqual(['done', 'done']))
    expect(store.get(a.id)?.progress).toEqual({ done: 1, total: 1, wait: null })
  })

  it('no meeting list is read per chunk; leftovers are asked for one meeting only', async () => {
    const m = make()
    const list = vi.spyOn(store, 'list')
    const left = vi.spyOn(store, 'leftovers')
    const { t } = queue()
    t.add(chunk(m.id, 'you', 0))
    t.add(chunk(m.id, 'others', 0))
    endRecording(m.id)
    t.ended(m.id)
    await vi.waitFor(() => expect(store.get(m.id)?.state).toBe('done'))
    expect(list).not.toHaveBeenCalled()
    expect(left.mock.calls.every((a) => a[0] === m.id)).toBe(true)
  })

  it('a meeting failed while recording (no engine) is queued again in full when its recording ends', async () => {
    const m = make()
    let bin: string | null = null
    let live: string | null = m.id
    const { t, w } = queue({ engine: () => bin, live: () => live })
    t.add(chunk(m.id, 'you', 0))
    await vi.waitFor(() => expect(store.get(m.id)?.state).toBe('failed'))
    // Still recording: a later chunk is kept on disk, not transcribed.
    t.add(chunk(m.id, 'others', 0))
    await new Promise((r) => setTimeout(r, 10))
    expect(w.calls).toEqual([])
    expect(onDisk(m.id, 'others', 0)).toBe(true)
    // The recorder's Stop puts it back to transcribing; ended() takes every chunk on disk.
    bin = '/acme/whisper-cli'
    live = null
    store.update(m.id, (x) => ({ ...x, ended: clock, state: 'transcribing', error: null }))
    t.ended(m.id)
    await vi.waitFor(() => expect(store.get(m.id)?.state).toBe('done'))
    expect(w.calls).toEqual(['you-0', 'others-0'])
  })

  it('forget drops a meeting from the queue', async () => {
    const a = make()
    const b = make()
    const { t, w, setModel } = queue()
    setModel(null)
    t.add(chunk(a.id, 'you', 0))
    t.add(chunk(b.id, 'you', 0))
    t.forget(a.id)
    setModel('/models/ggml-base.bin')
    t.modelReady()
    await vi.waitFor(() => expect(store.get(b.id)?.progress?.done).toBe(1))
    expect(w.calls).toEqual(['you-0'])
    expect(onDisk(a.id, 'you', 0)).toBe(true)
  })

  it('after stop nothing finishes, hands over or is tried again', () => {
    const done = make({ state: 'transcribing', ended: clock })
    const failed = make({ state: 'failed', ended: clock, error: 'x', segments: [{ start: 0, end: 5, speaker: 'you', text: 'hi' }] })
    const handed: string[] = []
    const { t } = queue({ onTranscribed: (id) => handed.push(id) })
    t.stop()
    t.ended(done.id)
    t.start()
    expect(t.retry(failed.id)).toMatchObject({ ok: false })
    expect(handed).toEqual([])
    expect(store.get(done.id)?.state).toBe('transcribing')
    expect(store.get(failed.id)?.state).toBe('failed')
  })

  it('a meeting left matching is handed to the matcher again at start', () => {
    const m = make({ state: 'matching', ended: clock })
    const handed: string[] = []
    queue({ onTranscribed: (id) => handed.push(id) }).t.start()
    expect(handed).toEqual([m.id])
  })

  it('stop (a quit): a run killed then leaves its chunk and the meeting as they were', async () => {
    const m = make()
    let reject: ((e: Error) => void) | null = null
    const transcribe = vi.fn(() => new Promise<HeardSegment[]>((_res, rej) => (reject = rej)))
    const { t } = queue({ transcribe })
    t.add(chunk(m.id, 'you', 0))
    await vi.waitFor(() => expect(reject).not.toBeNull())
    t.stop()
    reject!(new Error('whisper-cli failed (SIGKILL): '))
    await new Promise((r) => setTimeout(r, 10))
    expect(store.get(m.id)).toMatchObject({ state: 'recording', error: null, progress: { done: 0, total: 1, wait: null } })
    expect(onDisk(m.id, 'you', 0)).toBe(true)
    // Nothing more starts.
    t.add(chunk(m.id, 'others', 0))
    await new Promise((r) => setTimeout(r, 10))
    expect(transcribe).toHaveBeenCalledTimes(1)
  })
})
