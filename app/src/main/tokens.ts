import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mergeByDay, newFileTally, tallyLines, type FileTally, type Span, type TokensByDay } from '@shared/tokens'
import type { TranscriptIndex } from './files'

const CHUNK = 4 * 1024 * 1024
const VERSION = 2

/**
 * Tokens per session and day, from its transcript and its subagents' transcripts. Each file's
 * tally is saved (~/.claude/masterdeck/tokens.json), so after the first pass only new lines are
 * read. Reads are async and in chunks: hundreds of MB of history must not freeze the app.
 */
export class TokenIndex {
  private files: Record<string, FileTally> = {}
  private queue: Promise<unknown> = Promise.resolve()
  private dirty = false
  private savedAt = 0

  constructor(
    private transcripts: TranscriptIndex,
    private cachePath: string,
  ) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
      // Version 1 had no activity spans: read every transcript again once.
      if (raw && typeof raw === 'object' && raw.version === VERSION && raw.files && typeof raw.files === 'object') this.files = raw.files
    } catch {
      // first run: start empty
    }
  }

  /** The transcript files of a session: its own, then its subagents'. */
  private pathsFor(sessionId: string): string[] {
    const main = this.transcripts.find(sessionId)
    if (!main) return []
    const sub = join(dirname(main), sessionId, 'subagents')
    let subs: string[] = []
    try {
      subs = existsSync(sub) ? readdirSync(sub).filter((f) => f.endsWith('.jsonl')).map((f) => join(sub, f)) : []
    } catch {
      subs = []
    }
    return [main, ...subs]
  }

  private async readFile(path: string): Promise<void> {
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return
    }
    let t = this.files[path]
    // A file that shrank was rewritten: count it again.
    if (!t || size < t.offset) t = this.files[path] = newFileTally()
    if (size === t.offset) return
    const fh = await open(path, 'r')
    try {
      while (t.offset < size) {
        const len = Math.min(CHUNK, size - t.offset)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, t.offset)
        if (bytesRead <= 0) break
        t.offset += bytesRead
        const lines = (t.rest + buf.subarray(0, bytesRead).toString('utf8')).split('\n')
        t.rest = lines.pop() ?? ''
        tallyLines(t, lines)
        this.dirty = true
        // Let the app breathe between chunks.
        await new Promise((r) => setImmediate(r))
      }
    } finally {
      await fh.close()
    }
  }

  /** Bring these sessions up to date, then answer from their files' tallies (one read at a time). */
  private read<T>(sessionIds: string[], pick: (tallies: FileTally[]) => T): Promise<Record<string, T>> {
    const run = async () => {
      const out: Record<string, T> = {}
      for (const id of sessionIds) {
        const paths = this.pathsFor(id)
        for (const p of paths) await this.readFile(p)
        if (paths.length) out[id] = pick(paths.map((p) => this.files[p]).filter((t): t is FileTally => !!t))
      }
      // Live sessions add lines every few seconds: write the cache at most every 30 s (and on quit).
      if (Date.now() - this.savedAt > 30_000) this.save()
      return out
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Tokens per day for each of these sessions. */
  refresh(sessionIds: string[]): Promise<Record<string, TokensByDay>> {
    return this.read(sessionIds, (ts) => mergeByDay(ts.map((t) => t.byDay)))
  }

  /** When each of these sessions was active: its own and its subagents' spans (not merged). */
  activity(sessionIds: string[]): Promise<Record<string, Span[]>> {
    return this.read(sessionIds, (ts) => ts.flatMap((t) => t.spans ?? []))
  }

  save(): void {
    if (!this.dirty) return
    this.dirty = false
    this.savedAt = Date.now()
    try {
      writeFileSync(`${this.cachePath}.tmp`, JSON.stringify({ version: VERSION, files: this.files }))
      renameSync(`${this.cachePath}.tmp`, this.cachePath)
    } catch {
      this.dirty = true
    }
  }
}
