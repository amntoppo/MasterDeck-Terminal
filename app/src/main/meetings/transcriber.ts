import { existsSync, readFileSync } from 'node:fs'
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
import { silentChunk } from '@shared/meetingAudio'
import { MATCH_FAILED } from '@shared/meetingMatch'
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
    // A start past the chunk's end would put the line in the next chunk (and a rerun of that one would drop it).
    .map((h) => ({ h, start: offset + Math.min(Math.max(0, h.start), CHUNK_MS - 1) }))
    .map(({ h, start }) => ({ start, end: Math.max(start, offset + h.end), speaker: track, text: h.text.replace(CONTROLS, ' ').trim().slice(0, SEGMENT_TEXT_MAX) }))
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
 * The transcription queue (spec §3): one whisper-cli at a time, first in first out among the
 * meetings that can go on. Each closed chunk becomes the meeting's transcript lines (offset
 * seq × CHUNK_MS, speaker from its track), then its WAV is removed. Once a recording ended and its
 * last chunk is text, the two tracks are merged by time and the meeting goes on to matching.
 *
 * A meeting with no speech model on disk waits (it says so) until modelReady(), and the chunks of
 * other meetings go past it. A chunk that fails stays on disk and the meeting's other chunks go on;
 * once nothing of it waits, the meeting is failed with the first reason, and retry() reruns the
 * chunks still on disk. A missing whisper-cli fails the meeting at once (every chunk would).
 * A chunk with nothing to hear (silentChunk: a "you" chunk the mic gate zeroed, below SILENT_RMS;
 * an "others" chunk of exact zeros) is never given to whisper: no lines, its WAV removed, counted done.
 */
export class Transcriber {
  private queue: Chunk[] = []
  private queued = new Set<string>()
  /** Chunks made text in this run whose WAV could not be removed: never queued twice. */
  private done = new Set<string>()
  /** Chunks that failed in this run: not queued again until the meeting is failed (then retry takes them). */
  private skipped = new Set<string>()
  /** Per meeting, the first chunk failure: the meeting fails with it once nothing of it waits. */
  private failures = new Map<string, string>()
  private busy = false
  /** Something was queued while the loop ran: it looks again before it rests. */
  private again = false
  private stopped = false
  private running: Chunk | null = null

  constructor(private d: TranscriberDeps) {}

  /**
   * At load (after consent, never at startup): a meeting left `recording` by a crash or a forced
   * quit is `transcribing` now; the chunks left on disk go first, oldest meeting first; meetings
   * whose chunks were all text already are finished, and one left `matching` is handed over again.
   */
  start(): void {
    if (this.stopped) return
    const live = this.d.live()
    const left = new Map<string, Leftover[]>()
    for (const c of this.d.store.leftovers()) left.set(c.id, [...(left.get(c.id) ?? []), c])
    for (const m of this.d.store.list().reverse()) {
      if (m.id === live) continue
      const chunks = left.get(m.id) ?? []
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
    if (this.stopped) return
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

  /** A meeting was deleted: nothing of it is queued, and nothing remembered of it is kept. */
  forget(id: string): void {
    this.dropMeeting(id)
    const mine = `${id}/`
    for (const set of [this.done, this.skipped]) for (const k of [...set]) if (k.startsWith(mine)) set.delete(k)
    this.failures.delete(id)
  }

  /** Try again on a failed meeting: its chunks on disk are queued again (or, all text already, it is finished). */
  retry(id: string): { ok: true } | { ok: false; message: string } {
    if (this.stopped) return { ok: false, message: 'MasterDeck is quitting.' }
    const m = this.d.store.get(id)
    if (!m) return { ok: false, message: 'No such meeting.' }
    if (m.state !== 'failed') return { ok: false, message: 'Only a meeting whose transcription failed is tried again.' }
    // All text already, its matching failed: Match again (Matcher.rematch) is the way, not a second transcription.
    if (m.error?.startsWith(MATCH_FAILED)) return { ok: false, message: 'Use Match again.' }
    if (this.d.live() === id) return { ok: false, message: 'The meeting is being recorded.' }
    const chunks = this.d.store.leftovers(id)
    if (!chunks.length && !m.segments.length) return { ok: false, message: 'Nothing was recorded to transcribe.' }
    const u = this.d.store.update(id, (x) => ({ ...x, state: 'transcribing', error: null }))
    if (!u.ok) return u
    this.failures.delete(id)
    for (const c of chunks) {
      this.done.delete(keyOf(c))
      this.skipped.delete(keyOf(c))
      this.enqueue(c)
    }
    this.setProgress(id)
    this.finishIfDone(id)
    this.pump()
    return { ok: true }
  }

  private enqueue(c: Chunk): boolean {
    const k = keyOf(c)
    if (this.queued.has(k) || this.done.has(k) || this.skipped.has(k)) return false
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

  /** The meeting is failed: nothing of it waits, and what failed may be queued again (retry, or the recording's end). */
  private fail(id: string, why: string): void {
    this.dropMeeting(id)
    this.failures.delete(id)
    const mine = `${id}/`
    for (const k of [...this.skipped]) if (k.startsWith(mine)) this.skipped.delete(k)
    this.d.store.update(id, (m) => ({ ...m, state: 'failed', error: why, progress: m.progress ? { ...m.progress, wait: null } : null }))
    this.d.onChange?.(id)
  }

  private pump(): void {
    if (this.stopped || !this.queue.length) return
    if (this.busy) {
      this.again = true
      return
    }
    this.busy = true
    void this.loop()
      .catch((e) => console.error(`meetings: transcription queue: ${String(e)}`))
      .finally(() => {
        this.busy = false
        if (this.again) this.pump()
      })
  }

  /**
   * The first queued chunk that can run now. On the way, chunks with nothing to do (a meeting
   * deleted or failed meanwhile, no WAV) leave the queue, and each meeting with no speech model
   * says it waits; its chunks stay where they are.
   */
  private next(): { c: Chunk; m: Meeting; wav: string; model: string } | null {
    const waiting = new Set<string>()
    const gone = new Set<string>()
    const read = new Map<string, Meeting | null>()
    let found: { c: Chunk; m: Meeting; wav: string; model: string } | null = null
    for (const c of [...this.queue]) {
      if (waiting.has(c.id)) continue
      if (!read.has(c.id)) read.set(c.id, this.d.store.get(c.id))
      const m = read.get(c.id) ?? null
      const wav = this.d.store.chunkPath(c.id, c.track, c.seq)
      if (!m || (m.state !== 'transcribing' && m.state !== 'recording') || !wav || !existsSync(wav)) {
        this.shift(c)
        if (m) gone.add(c.id)
        continue
      }
      const model = this.d.modelPath(m)
      if (!model) {
        waiting.add(c.id)
        if (m.progress?.wait !== WAIT_MODEL) this.setProgress(c.id, { wait: WAIT_MODEL })
        continue
      }
      found = { c, m, wav, model }
      break
    }
    for (const id of gone) this.finishIfDone(id)
    return found
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.again = false
      const next = this.next()
      if (!next) return
      const { c, m, wav, model } = next
      if (m.progress?.wait) this.setProgress(c.id, { wait: null })
      // Nothing to hear (the mic gate's zeros, digital silence): no whisper, which would make lines up.
      if (this.silent(c, wav)) {
        this.shift(c)
        this.written(c, [])
        continue
      }
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
        this.running = null
        // The chunk stays on disk; the meeting's other chunks go on, and it fails once they are done.
        this.shift(c)
        if (this.d.store.get(c.id)) {
          this.skipped.add(keyOf(c))
          if (!this.failures.has(c.id)) this.failures.set(c.id, reason(e))
          this.setProgress(c.id)
          this.finishIfDone(c.id)
        }
        continue
      } finally {
        this.running = null
      }
      this.shift(c)
      this.written(c, chunkSegments(heard, c.track, c.seq))
    }
  }

  /** A chunk that silentChunk says has nothing for whisper (an unreadable file: whisper decides). */
  private silent(c: Chunk, wav: string): boolean {
    try {
      return silentChunk(readFileSync(wav), c.track)
    } catch {
      return false
    }
  }

  /** A chunk is text: its lines replace what it wrote before, progress counts it, its WAV goes. */
  private written(c: Chunk, lines: Segment[]): void {
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
      // Deleted while whisper ran: nothing to write to.
      if (this.d.store.get(c.id)) this.fail(c.id, `Transcription failed: ${u.message}`)
      return
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

  private shift(c: Chunk): void {
    if (this.queue[0] === c) this.queue.shift()
    else this.queue = this.queue.filter((x) => x !== c)
    this.queued.delete(keyOf(c))
  }

  /**
   * The recording ended and nothing of the meeting waits: a chunk failed, and it is failed with
   * the reason; else one transcript by time, then matching (or done).
   */
  private finishIfDone(id: string): void {
    if (this.stopped) return
    const m = this.d.store.get(id)
    if (!m || m.state !== 'transcribing' || this.d.live() === id) return
    if (this.pending(id) || (this.running && this.running.id === id)) return
    // A chunk on disk the queue never heard of (written while it was not loaded): take it first.
    const missed = this.d.store.leftovers(id).filter((c) => this.enqueue(c))
    if (missed.length) {
      this.setProgress(id)
      this.pump()
      return
    }
    const failed = this.failures.get(id)
    if (failed) return this.fail(id, failed)
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
    if (this.stopped) return
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
