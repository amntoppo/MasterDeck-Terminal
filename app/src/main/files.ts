import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Read at most `max` bytes from the end of a file. `fromStart` says whether the whole file fit. */
export function readTail(path: string, max = 64 * 1024): { text: string; fromStart: boolean; mtimeMs: number } | null {
  let fd: number | null = null
  try {
    const st = statSync(path)
    const start = Math.max(0, st.size - max)
    const len = st.size - start
    const buf = Buffer.alloc(len)
    fd = openSync(path, 'r')
    readSync(fd, buf, 0, len, start)
    return { text: buf.toString('utf8'), fromStart: start === 0, mtimeMs: st.mtimeMs }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Finds `~/.claude/projects/<any>/<sessionId>.jsonl`, caching hits and rescanning misses at most every 30 s. */
export class TranscriptIndex {
  private hits = new Map<string, string>()
  private lastScan = 0
  private all = new Map<string, string>()

  constructor(private projectsDir: string) {}

  find(sessionId: string, now = Date.now()): string | null {
    const hit = this.hits.get(sessionId)
    if (hit && mtime(hit) !== null) return hit
    if (this.all.has(sessionId)) {
      const p = this.all.get(sessionId)!
      this.hits.set(sessionId, p)
      return p
    }
    if (now - this.lastScan > 30_000) {
      this.scan()
      this.lastScan = now
      const p = this.all.get(sessionId)
      if (p) {
        this.hits.set(sessionId, p)
        return p
      }
    }
    return null
  }

  private scan(): void {
    this.all.clear()
    let dirs: string[] = []
    try {
      dirs = readdirSync(this.projectsDir)
    } catch {
      return
    }
    for (const d of dirs) {
      let files: string[] = []
      try {
        files = readdirSync(join(this.projectsDir, d))
      } catch {
        continue
      }
      for (const f of files) if (f.endsWith('.jsonl')) this.all.set(f.slice(0, -6), join(this.projectsDir, d, f))
    }
  }
}

export interface FollowState {
  path: string
  offset: number
  /** An incomplete last line, carried to the next read. */
  rest: string
}

/**
 * Read the complete lines appended to a file since the last call. The first read starts at most
 * `firstMax` bytes from the end; a file that shrank (rewritten) is read again from the start.
 */
export function readNewLines(st: FollowState, firstMax = 8 * 1024 * 1024, maxChunk = 8 * 1024 * 1024): string[] {
  let fd: number | null = null
  try {
    const size = statSync(st.path).size
    if (size < st.offset) {
      st.offset = 0
      st.rest = ''
    }
    if (st.offset === 0 && size > firstMax) st.offset = size - firstMax
    if (size === st.offset) return []
    const len = Math.min(size - st.offset, maxChunk)
    const buf = Buffer.alloc(len)
    fd = openSync(st.path, 'r')
    readSync(fd, buf, 0, len, st.offset)
    st.offset += len
    const text = st.rest + buf.toString('utf8')
    const lines = text.split('\n')
    st.rest = lines.pop() ?? ''
    // A first read that began mid-file starts with a partial line; the JSON parser skips it.
    return lines
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
