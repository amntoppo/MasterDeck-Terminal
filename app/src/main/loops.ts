import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompiledLoop } from '@shared/flow'
import { validSessionId } from '@shared/flow'
import type { CliResult } from '@shared/types'
import {
  LOOP_MORE,
  type LoopEntry,
  type LoopFile,
  type LoopHistory,
  type LoopView,
  loopViews,
  parseLoopFile,
  validLoopId,
} from '@shared/loops'

/** The progress file's text is read up to this much (its end: notes are appended). */
export const PROGRESS_MAX = 64 * 1024

/**
 * The workflow loops' files (`<home>/workflows/loops/<sid>.json`), which the loop hook and the
 * trigger hooks write from outside the app: read on change (by mtime), and the user's two writes,
 * Stop loop and Run 5 more.
 */
export class LoopStore {
  private cache = new Map<string, { mtime: number; file: LoopFile }>()
  private seen = ''

  constructor(
    private home: string,
    /** The session's compiled loops (names and limits), from its workflow. */
    private defs: (sessionId: string) => CompiledLoop[],
  ) {}

  get dir(): string {
    return join(this.home, 'workflows', 'loops')
  }

  private fileOf(sid: string): string {
    return join(this.dir, `${sid}.json`)
  }

  /** A session's loop file; null when there is none (or the id is not a session's). */
  read(sid: string): LoopFile | null {
    if (!validSessionId(sid)) return null
    const f = this.fileOf(sid)
    let mtime: number
    try {
      mtime = statSync(f).mtimeMs
    } catch {
      this.cache.delete(sid)
      return null
    }
    const hit = this.cache.get(sid)
    if (hit && hit.mtime === mtime) return hit.file
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(f, 'utf8'))
    } catch {
      // a file being written, or not one: read as empty
    }
    const file = parseLoopFile(raw)
    this.cache.set(sid, { mtime, file })
    return file
  }

  /** `AppState.loops`: the sessions with loops to show. */
  views(sessionIds: string[], now: number): Record<string, LoopView[]> {
    const out: Record<string, LoopView[]> = {}
    for (const sid of sessionIds) {
      const file = this.read(sid)
      if (!file?.loops.length) continue
      const v = loopViews(file, this.defs(sid), now)
      if (v.length) out[sid] = v
    }
    return out
  }

  /** Whether any loop file appeared, went or changed since the last call (the poll tick asks). */
  changed(): boolean {
    let sig = ''
    try {
      for (const n of readdirSync(this.dir).sort())
        if (n.endsWith('.json')) {
          try {
            sig += `${n}:${statSync(join(this.dir, n)).mtimeMs};`
          } catch {
            // gone between the listing and the stat
          }
        }
    } catch {
      // no loops folder yet
    }
    if (sig === this.seen) return false
    this.seen = sig
    return true
  }

  private entry(sid: unknown, id: unknown): { sid: string; file: LoopFile; k: number } | { message: string } {
    if (!validSessionId(sid)) return { message: 'not a session id' }
    if (!validLoopId(id)) return { message: 'not a loop id' }
    const file = this.read(sid)
    const k = file ? file.loops.findIndex((e) => e.id === id) : -1
    if (!file || k < 0) return { message: 'no such loop' }
    return { sid, file, k }
  }

  // The hook reads the file again just before its rename and drops its round when the loop is no
  // longer open or has a new start, so a Stop loop or Run 5 more during a check stands.
  // ponytail: what is left is the moment between that read and the rename (last rename wins); a
  // lock file shared with loop.sh is the upgrade path.
  private write(sid: string, file: LoopFile): void {
    const f = this.fileOf(sid)
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file))
    renameSync(tmp, f)
    this.cache.delete(sid)
  }

  private name(sid: string, id: string): string {
    return this.defs(sid).find((d) => d.id === id)?.name || id
  }

  /** Stop loop: an open loop ends now; its stop goes through at the next turn end. */
  stop(sid: unknown, id: unknown, now = Date.now()): CliResult {
    const r = this.entry(sid, id)
    if ('message' in r) return { ok: false, message: r.message }
    const e = r.file.loops[r.k]
    if (e.state !== 'open') return { ok: false, message: 'the loop is not running' }
    const loops = [...r.file.loops]
    loops[r.k] = { ...e, state: 'stopped', reason: 'stopped by you', endedAt: now }
    this.write(r.sid, { ...r.file, loops })
    return { ok: true, message: 'loop stopped' }
  }

  /**
   * Run 5 more: a loop that ended at a limit is open again with 5 more iterations. It takes
   * effect at the session's next turn end (the caller nudges an idle session).
   */
  more(sid: unknown, id: unknown, now = Date.now()): CliResult & { name?: string } {
    const r = this.entry(sid, id)
    if ('message' in r) return { ok: false, message: r.message }
    const e = r.file.loops[r.k]
    if (e.state !== 'limit') return { ok: false, message: 'only a loop stopped at a limit can run more' }
    // The hook takes the first open loop: a second one open would run instead of the next.
    if (r.file.loops.some((x) => x.state === 'open'))
      return { ok: false, message: 'another loop is running' }
    const { endedAt: _gone, ...rest } = e
    const next: LoopEntry = {
      ...rest,
      state: 'open',
      reason: null,
      extra: (e.extra ?? 0) + LOOP_MORE,
      // A fresh start, so a loop stopped by its time limit does not hit it again at once; the
      // iteration count goes on, against the limit plus the extra.
      startedAt: now,
      // Rounds so far do not count toward the stall limit: a stalled loop gets new rounds first.
      stallFrom: e.iteration,
    }
    const loops = [...r.file.loops]
    loops[r.k] = next
    this.write(r.sid, { ...r.file, loops })
    return { ok: true, message: `${LOOP_MORE} more iterations`, name: this.name(r.sid, e.id) }
  }

  /** A loop's every round and the end of its progress file. */
  history(sid: unknown, id: unknown): LoopHistory {
    const r = this.entry(sid, id)
    if ('message' in r) return { ok: false, message: r.message }
    const e = r.file.loops[r.k]
    return { ok: true, name: this.name(r.sid, e.id), history: e.history, progress: readEnd(join(this.dir, `${r.sid}-${e.id}.md`), PROGRESS_MAX) }
  }
}

/** The last `max` bytes of a file ('' when there is none). */
function readEnd(f: string, max: number): string {
  if (!existsSync(f)) return ''
  let fd: number | null = null
  try {
    const size = statSync(f).size
    const len = Math.min(size, max)
    const buf = Buffer.alloc(len)
    fd = openSync(f, 'r')
    readSync(fd, buf, 0, len, size - len)
    // A cut may land inside a character: drop what decodes to the replacement mark at the start.
    return buf.toString('utf8').replace(/^�+/, '')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
