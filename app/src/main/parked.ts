import { readFileSync, statSync } from 'node:fs'
import { parkedFor, parseParked, type Parked } from '@shared/parked'

/**
 * `parked-sessions.json` (written by `master spawn`, never by the app): read again when it
 * changed. Missing or unreadable: no session is parked, so every session is treated as before.
 */
export class ParkedStore {
  private all: Record<string, Parked> = {}
  private mtime = ''

  constructor(private file: string) {}

  get(s: { key: string; name: string; cwd: string; startedAt: number }): Parked | null {
    let m: string
    try {
      const st = statSync(this.file)
      m = `${st.mtimeMs}:${st.size}` // size too: two writes can share a timestamp
    } catch {
      return null
    }
    if (m !== this.mtime) {
      this.mtime = m
      try {
        this.all = parseParked(JSON.parse(readFileSync(this.file, 'utf8')))
      } catch {
        this.all = {}
      }
    }
    return parkedFor(this.all, s)
  }
}
