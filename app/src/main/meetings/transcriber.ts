import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  CHUNK_MS,
  MEETING_ERROR_MAX,
  MEETING_SEGMENTS_MAX,
  mergeSegments,
  SEGMENT_TEXT_MAX,
  type Meeting,
  type MeetingProgress,
  type Segment,
  type Speaker,
} from '@shared/meetings'
import type { Leftover, MeetingStore } from './store'
import type { Segment as HeardSegment, TranscribeOptions } from './whisper'

/** A chunk waiting for whisper: `<id>/chunks/<track>-<seq>.wav`. */
export interface Chunk {
  id: string
  track: Speaker
  seq: number
}

export interface TranscriberDeps {
  store: Pick<MeetingStore, 'get' | 'list' | 'update' | 'leftovers' | 'chunkPath' | 'removeChunk'>
  /** The speech model file to use for this meeting, when one is on disk; null: it waits. */
  modelPath(m: Meeting): string | null
  /** whisper-cli, or null when it is missing. */
  engine(): string | null
  /** whisper.ts's transcribe (tests pass a fake). */
  transcribe(o: TranscribeOptions): Promise<HeardSegment[]>
  /** The meeting being recorded now, if any: it is finished only once its recording ended. */
  live(): string | null
  /**
   * All of a meeting's chunks are text: it is `matching` and this takes it on (the matcher). Without
   * one, the meeting is `done` there.
   */
  onTranscribed?(id: string): void
  /** A meeting's state or progress changed (the Meetings page reads it again). */
  onChange?(id: string): void
  now?: () => number
}

export const WAIT_MODEL = 'Waiting for the speech model'
const ENGINE_MISSING = 'The speech engine (whisper-cli) is missing.'

const keyOf = (c: Chunk): string => `${c.id}/${c.track}-${c.seq}`
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g

/** What whisper heard, as transcript lines of this chunk: its offset, its speaker, text the meeting file accepts. */
export function chunkSegments(heard: HeardSegment[], track: Speaker, seq: number): Segment[] {
  const offset = seq * CHUNK_MS
  return heard
    .map((h) => ({ start: offset + h.start, end: offset + h.end, speaker: track, text: h.text.replace(CONTROLS, ' ').trim().slice(0, SEGMENT_TEXT_MAX) }))
    .filter((s) => s.text)
}

/** A failure in plain words: one line, no home folder, short enough for the meeting file. */
function reason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const home = homedir()
  const text = (home ? raw.split(home).join('~') : raw).replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim()
  return `Transcription failed: ${text || 'unknown error'}`.slice(0, MEETING_ERROR_MAX)
}

/**
 * The transcription queue (spec §3): one whisper-cli at a time, first in first out. Each closed
 * chunk becomes the meeting's transcript lines (offset seq × CHUNK_MS, speaker from its track),
 * then its WAV is removed. Once a recording ended and its last chunk is text, the two tracks are
 * merged by time and the meeting goes on to matching. A failure keeps the chunk and marks the
 * meeting failed with the reason; retry() queues it again. With no speech model on disk the queue
 * waits (the meeting says so) until modelReady().
 */
export class Transcriber {
  private queue: Chunk[] = []
  private queued = new Set<string>()
  /** Chunks made text in this run whose WAV could not be removed: never queued twice. */
  private done = new Set<string>()
  private busy = false
  private stopped = false
  private running: Chunk | null = null

  constructor(private d: TranscriberDeps) {}

  /**
   * At load (after consent, never at startup): a meeting left `recording` by a crash or a forced
   * quit is `transcribing` now; the chunks left on disk go first, oldest meeting first; meetings
   * whose chunks were all text already are finished, and one left `matching` is handed over again.
   */
  start(): void {
    const live = this.d.live()
    const left = this.d.store.leftovers()
    const oldestFirst = this.d.store.list().reverse()
    for (const m of oldestFirst) {
      if (m.id === live) continue
      const chunks = left.filter((c) => c.id === m.id)
      if (m.state === 'recording') this.recover(m, chunks)
      const now = this.d.store.get(m.id)
      if (!now) continue
      if (now.state === 'transcribing') {
        for (const c of chunks) this.enqueue(c)
        if (chunks.length) this.setProgress(m.id)
        this.finishIfDone(m.id)
      } else if (now.state === 'matching') this.handOver(m.id)
    }
    this.pump()
  }

  /** A recording that never ended: it ends at the last thing recorded, and goes on to transcription. */
  private recover(m: Meeting, chunks: Leftover[]): void {
    const lastSeq = chunks.reduce((n, c) => Math.max(n, c.seq), -1)
    const lastSaid = m.segments.reduce((n, s) => Math.max(n, s.end), 0)
    const span = Math.max(lastSaid, (lastSeq + 1) * CHUNK_MS)
    const nothing = chunks.length === 0 && m.segments.length === 0
    this.d.store.update(m.id, (x) => ({
      ...x,
      ended: Math.min((this.d.now ?? Date.now)(), Math.max(x.started, x.started + x.pausedMs + span)),
      state: nothing ? 'failed' : 'transcribing',
      error: nothing ? 'Nothing was recorded.' : (x.error ?? 'MasterDeck stopped while recording; the transcript has what was saved.'),
    }))
    this.d.onChange?.(m.id)
  }

  /** The recorder wrote a chunk. */
  add(c: Chunk): void {
    if (this.stopped) return
    if (this.enqueue(c)) this.setProgress(c.id)
    this.pump()
  }

  /** The recorder ended this meeting: finish it when nothing of it waits. */
  ended(id: string): void {
    this.finishIfDone(id)
  }

  /** A speech model is on disk now (a download finished, a ready one was picked): the queue goes on. */
  modelReady(): void {
    this.pump()
  }

  /** Quitting: nothing more starts, and a run killed now leaves its chunk for the next start (not failed). */
  stop(): void {
    this.stopped = true
  }

  /** Try again on a failed meeting: its chunks on disk are queued again (or, all text already, it is finished). */
  retry(id: string): { ok: true } | { ok: false; message: string } {
    const m = this.d.store.get(id)
    if (!m) return { ok: false, message: 'No such meeting.' }
    if (m.state !== 'failed') return { ok: false, message: 'Only a meeting whose transcription failed is tried again.' }
    if (this.d.live() === id) return { ok: false, message: 'The meeting is being recorded.' }
    const chunks = this.d.store.leftovers().filter((c) => c.id === id)
    if (!chunks.length && !m.segments.length) return { ok: false, message: 'Nothing was recorded to transcribe.' }
    const u = this.d.store.update(id, (x) => ({ ...x, state: 'transcribing', error: null }))
    if (!u.ok) return u
    for (const c of chunks) {
      this.done.delete(keyOf(c))
      this.enqueue(c)
    }
    this.setProgress(id)
    this.d.onChange?.(id)
    this.finishIfDone(id)
    this.pump()
    return { ok: true }
  }

  private enqueue(c: Chunk): boolean {
    const k = keyOf(c)
    if (this.queued.has(k) || this.done.has(k)) return false
    this.queued.add(k)
    this.queue.push({ id: c.id, track: c.track, seq: c.seq })
    return true
  }

  private dropMeeting(id: string): void {
    this.queue = this.queue.filter((c) => {
      if (c.id !== id) return true
      this.queued.delete(keyOf(c))
      return false
    })
  }

  private pending(id: string): number {
    return this.queue.filter((c) => c.id === id).length
  }

  /** done stays what was stored; total is done plus what waits now. */
  private setProgress(id: string, change: Partial<MeetingProgress> = {}): void {
    this.d.store.update(id, (m) => {
      const done = change.done ?? m.progress?.done ?? 0
      return { ...m, progress: { done, total: done + this.pending(id), wait: change.wait !== undefined ? change.wait : (m.progress?.wait ?? null) } }
    })
    this.d.onChange?.(id)
  }

  private fail(id: string, why: string): void {
    this.dropMeeting(id)
    this.d.store.update(id, (m) => ({ ...m, state: 'failed', error: why, progress: m.progress ? { ...m.progress, wait: null } : null }))
    this.d.onChange?.(id)
  }

  private pump(): void {
    if (this.busy || this.stopped || !this.queue.length) return
    this.busy = true
    void this.loop()
      .catch((e) => console.error(`meetings: transcription queue: ${String(e)}`))
      .finally(() => {
        this.busy = false
      })
  }

  private async loop(): Promise<void> {
    while (!this.stopped && this.queue.length) {
      const c = this.queue[0]
      const m = this.d.store.get(c.id)
      const wav = this.d.store.chunkPath(c.id, c.track, c.seq)
      // Gone (deleted, failed meanwhile) or no file: nothing to do for this chunk.
      if (!m || (m.state !== 'transcribing' && m.state !== 'recording') || !wav || !existsSync(wav)) {
        this.shift(c)
        if (m) this.finishIfDone(c.id)
        continue
      }
      const model = this.d.modelPath(m)
      if (!model) {
        // Waits at the head of the queue: modelReady() starts it again.
        if (m.progress?.wait !== WAIT_MODEL) this.setProgress(c.id, { wait: WAIT_MODEL })
        return
      }
      if (m.progress?.wait) this.setProgress(c.id, { wait: null })
      const bin = this.d.engine()
      if (!bin) {
        this.fail(c.id, ENGINE_MISSING)
        continue
      }
      let heard: HeardSegment[]
      this.running = c
      try {
        heard = await this.d.transcribe({ bin, wav, model, language: m.language })
      } catch (e) {
        // A quit killed it: the chunk stays and the next start takes it.
        if (this.stopped) return
        this.fail(c.id, reason(e))
        continue
      } finally {
        this.running = null
      }
      this.shift(c)
      const lines = chunkSegments(heard, c.track, c.seq)
      const u = this.d.store.update(c.id, (x) => {
        // Lines this chunk wrote before (a run whose WAV was not removed) are replaced, not doubled.
        const kept = x.segments.filter((s) => !(s.speaker === c.track && s.start >= c.seq * CHUNK_MS && s.start < (c.seq + 1) * CHUNK_MS))
        // ponytail: past MEETING_SEGMENTS_MAX lines (far beyond 4 hours of talk) the rest is dropped; upgrade: a second file.
        const segments = mergeSegments(
          [...kept, ...lines].filter((s) => s.speaker === 'you'),
          [...kept, ...lines].filter((s) => s.speaker === 'others'),
        ).slice(0, MEETING_SEGMENTS_MAX)
        const done = (x.progress?.done ?? 0) + 1
        return { ...x, segments, progress: { done, total: done + this.pending(c.id), wait: null } }
      })
      if (!u.ok) {
        this.fail(c.id, `Transcription failed: ${u.message}`)
        continue
      }
      this.done.add(keyOf(c))
      try {
        this.d.store.removeChunk(c.id, c.track, c.seq)
      } catch {
        // Left on disk: done holds it, so it is not transcribed again in this run.
      }
      this.d.onChange?.(c.id)
      this.finishIfDone(c.id)
    }
  }

  private shift(c: Chunk): void {
    if (this.queue[0] === c) this.queue.shift()
    else this.queue = this.queue.filter((x) => x !== c)
    this.queued.delete(keyOf(c))
  }

  /** The recording ended and every chunk is text: one transcript by time, then matching (or done). */
  private finishIfDone(id: string): void {
    const m = this.d.store.get(id)
    if (!m || m.state !== 'transcribing' || this.d.live() === id) return
    if (this.pending(id) || (this.running && this.running.id === id)) return
    // A chunk on disk the queue never heard of (written while it was not loaded): take it first.
    const missed = this.d.store.leftovers().filter((c) => c.id === id && this.enqueue(c))
    if (missed.length) {
      this.setProgress(id)
      this.pump()
      return
    }
    const next = this.d.onTranscribed ? 'matching' : 'done'
    const u = this.d.store.update(id, (x) => ({
      ...x,
      segments: mergeSegments(
        x.segments.filter((s) => s.speaker === 'you'),
        x.segments.filter((s) => s.speaker === 'others'),
      ),
      state: next,
      progress: { done: x.progress?.done ?? 0, total: x.progress?.done ?? 0, wait: null },
    }))
    if (!u.ok) return this.fail(id, `Transcription failed: ${u.message}`)
    this.d.onChange?.(id)
    if (next === 'matching') this.handOver(id)
  }

  private handOver(id: string): void {
    if (!this.d.onTranscribed) {
      this.d.store.update(id, (x) => ({ ...x, state: 'done' }))
      this.d.onChange?.(id)
      return
    }
    try {
      this.d.onTranscribed(id)
    } catch (e) {
      console.error(`meetings: matching: ${String(e)}`)
    }
  }
}
