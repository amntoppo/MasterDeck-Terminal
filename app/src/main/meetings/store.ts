import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUDIO_MAX_BYTES,
  CHUNK_SEQ_MAX,
  MEETING_ID,
  storedMeeting,
  TRACKS,
  type Meeting,
  type Speaker,
} from '@shared/meetings'

export type StoreResult = { ok: true } | { ok: false; message: string }

/** A transcribed or still waiting chunk on disk: `<id>/chunks/<track>-<seq>.wav`. */
export interface Leftover {
  id: string
  track: Speaker
  seq: number
  path: string
}

/** What Janitor shows per meeting (spec §7). */
export interface MeetingSizes {
  id: string
  title: string
  started: number
  audio: number
  transcript: number
  chunks: number
}

const MEETING_FILE = /^(m-[0-9a-f]{32})\.json$/
const CHUNK_FILE = /^(you|others)-(\d{1,4})\.wav$/
const AUDIO = 'audio.webm'

const size = (p: string): number => {
  try {
    const s = lstatSync(p)
    return s.isFile() ? s.size : 0
  } catch {
    return 0
  }
}

const isFile = (p: string): boolean => {
  try {
    return lstatSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * The meetings on disk, MASTERDECK_HOME/meetings (spec §8): `<id>.json` (written atomically),
 * `<id>/audio.webm` (appended in slices) and `<id>/chunks/<track>-<seq>.wav` (gone once
 * transcribed). An id is only ever used as a path after MEETING_ID matched it. A file there that
 * is not a meeting MasterDeck wrote is never overwritten or removed: delete takes only the files
 * it knows by name, and a folder it does not empty stays.
 */
export class MeetingStore {
  constructor(
    readonly dir: string,
    private now: () => number = Date.now,
  ) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private folder(id: string): string {
    return join(this.dir, id)
  }

  /** The stored meeting, or null (a bad id, no file, or a file that is not a meeting). */
  get(id: unknown): Meeting | null {
    if (typeof id !== 'string' || !MEETING_ID.test(id)) return null
    try {
      return storedMeeting(JSON.parse(readFileSync(this.file(id), 'utf8')), id)
    } catch {
      return null
    }
  }

  /** Every meeting that started in [from, to), newest first; foreign files are skipped. */
  list(from = 0, to = Number.MAX_SAFE_INTEGER): Meeting[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: Meeting[] = []
    for (const n of names) {
      const m = MEETING_FILE.exec(n)
      const meeting = m ? this.get(m[1]) : null
      if (meeting && meeting.started >= from && meeting.started < to) out.push(meeting)
    }
    return out.sort((a, b) => b.started - a.started)
  }

  private write(m: Meeting): StoreResult {
    const file = this.file(m.id)
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(tmp, JSON.stringify(m, null, 2))
      renameSync(tmp, file)
      return { ok: true }
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
      return { ok: false, message: diskError(e) }
    }
  }

  /** A new meeting (state recording) under a fresh id, with its folders. */
  create(o: { title: string; titleBy: Meeting['titleBy']; model: string | null; language: string }): { ok: true; meeting: Meeting } | { ok: false; message: string } {
    let id = ''
    // A clash of 128 random bits will not happen; the loop only makes "never overwrite" literal.
    for (let i = 0; i < 5 && (!id || existsSync(this.file(id)) || existsSync(this.folder(id))); i++) id = `m-${randomBytes(16).toString('hex')}`
    if (existsSync(this.file(id)) || existsSync(this.folder(id))) return { ok: false, message: 'Could not make a new meeting.' }
    const meeting: Meeting = {
      id,
      title: o.title,
      titleBy: o.titleBy,
      started: this.now(),
      ended: null,
      pausedMs: 0,
      apps: [],
      state: 'recording',
      model: o.model,
      language: o.language,
      segments: [],
      summary: null,
      matches: [],
      error: null,
    }
    try {
      mkdirSync(join(this.folder(id), 'chunks'), { recursive: true })
    } catch (e) {
      return { ok: false, message: diskError(e) }
    }
    const w = this.write(meeting)
    return w.ok ? { ok: true, meeting } : w
  }

  /** Change a stored meeting (atomically). Refused for a bad id or a file that is not a meeting; the id never changes. */
  update(id: unknown, change: (m: Meeting) => Meeting): { ok: true; meeting: Meeting } | { ok: false; message: string } {
    const old = this.get(id)
    if (!old) return { ok: false, message: 'No such meeting.' }
    const next = storedMeeting(JSON.parse(JSON.stringify({ ...change(old), id: old.id })), old.id)
    if (!next) return { ok: false, message: 'Not a meeting.' }
    const w = this.write(next)
    return w.ok ? { ok: true, meeting: next } : w
  }

  /** Where a chunk goes; null for a bad id, track or sequence number. */
  chunkPath(id: unknown, track: unknown, seq: unknown): string | null {
    if (typeof id !== 'string' || !MEETING_ID.test(id)) return null
    if (!TRACKS.includes(track as Speaker)) return null
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > CHUNK_SEQ_MAX) return null
    return join(this.folder(id), 'chunks', `${track}-${seq}.wav`)
  }

  /** A chunk's WAV, atomically; never over a file that is there already. The bytes were checked by the caller. */
  writeChunk(id: string, track: Speaker, seq: number, bytes: Uint8Array): StoreResult {
    const p = this.chunkPath(id, track, seq)
    if (!p || !this.get(id)) return { ok: false, message: 'Not a chunk.' }
    if (existsSync(p)) return { ok: false, message: 'That chunk is there already.' }
    const tmp = `${p}.${process.pid}.tmp`
    try {
      mkdirSync(join(this.folder(id), 'chunks'), { recursive: true })
      writeFileSync(tmp, bytes)
      renameSync(tmp, p)
      return { ok: true }
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
      return { ok: false, message: diskError(e) }
    }
  }

  /** The playback copy; null for a bad id. */
  audioPath(id: unknown): string | null {
    return typeof id === 'string' && MEETING_ID.test(id) ? join(this.folder(id), AUDIO) : null
  }

  /**
   * One 10-second slice at the end of audio.webm. Appending is not atomic: a crash loses at most
   * the slice being written, and the file plays up to there (WebM is a stream).
   */
  appendAudio(id: string, bytes: Uint8Array): StoreResult {
    const p = this.audioPath(id)
    if (!p || !this.get(id)) return { ok: false, message: 'Not a meeting.' }
    if (existsSync(p) && !isFile(p)) return { ok: false, message: 'Not a meeting.' }
    if (size(p) + bytes.length > AUDIO_MAX_BYTES) return { ok: false, message: 'The recording is too large.' }
    try {
      appendFileSync(p, bytes)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: diskError(e) }
    }
  }

  /** The chunks still on disk (a crash, or not transcribed yet), for meetings that exist: by meeting, then sequence, you first. */
  leftovers(): Leftover[] {
    const out: Leftover[] = []
    for (const m of this.list()) {
      const dir = join(this.folder(m.id), 'chunks')
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const n of names) {
        const c = CHUNK_FILE.exec(n)
        const p = join(dir, n)
        if (c && isFile(p)) out.push({ id: m.id, track: c[1] as Speaker, seq: Number(c[2]), path: p })
      }
    }
    return out.sort((a, b) => (a.id === b.id ? a.seq - b.seq || (a.track === b.track ? 0 : a.track === 'you' ? -1 : 1) : a.id < b.id ? -1 : 1))
  }

  /** Remove one transcribed chunk (only a chunk's own name). */
  removeChunk(id: string, track: Speaker, seq: number): void {
    const p = this.chunkPath(id, track, seq)
    if (p && isFile(p)) unlinkSync(p)
  }

  /** Per meeting: the audio's, the transcript's and the chunks' bytes. */
  sizes(): MeetingSizes[] {
    return this.list().map((m) => {
      const chunks = this.leftoversOf(m.id).reduce((n, c) => n + size(c), 0)
      return { id: m.id, title: m.title, started: m.started, audio: size(join(this.folder(m.id), AUDIO)), transcript: size(this.file(m.id)), chunks }
    })
  }

  private leftoversOf(id: string): string[] {
    const dir = join(this.folder(id), 'chunks')
    try {
      return readdirSync(dir)
        .filter((n) => CHUNK_FILE.test(n))
        .map((n) => join(dir, n))
    } catch {
      return []
    }
  }

  /** Delete the audio (the transcript and the notes stay). */
  deleteAudio(id: unknown): StoreResult {
    if (!this.get(id)) return { ok: false, message: 'No such meeting.' }
    const p = join(this.folder(id as string), AUDIO)
    try {
      if (isFile(p)) unlinkSync(p)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: diskError(e) }
    }
  }

  /**
   * Delete a meeting: its file, its audio, its chunks, then its folders if that left them empty.
   * Anything else in its folder stays (and so the folder does).
   */
  delete(id: unknown): StoreResult {
    if (!this.get(id)) return { ok: false, message: 'No such meeting.' }
    const mid = id as string
    try {
      for (const c of this.leftoversOf(mid)) if (isFile(c)) unlinkSync(c)
      const audio = join(this.folder(mid), AUDIO)
      if (isFile(audio)) unlinkSync(audio)
      for (const d of [join(this.folder(mid), 'chunks'), this.folder(mid)])
        try {
          if (statSync(d).isDirectory() && readdirSync(d).length === 0) rmdirSync(d)
        } catch {}
      unlinkSync(this.file(mid))
      return { ok: true }
    } catch (e) {
      return { ok: false, message: diskError(e) }
    }
  }
}

/** A disk failure in plain words, without the path (it names the user's home). */
function diskError(e: unknown): string {
  const code = (e as { code?: string })?.code
  if (code === 'ENOSPC') return 'The disk is full.'
  if (code === 'EACCES' || code === 'EPERM') return 'MasterDeck may not write to its meetings folder.'
  return 'Could not write the meeting to disk.'
}
