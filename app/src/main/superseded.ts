import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** ponytail: ids only ever added, the oldest dropped past this. */
const KEEP = 2000

/** `superseded-sessions.json`: a JSON array of bg ids and session ids (see shared/superseded.ts). `master spawn` adds to it too. */
export class Superseded {
  private set = new Set<string>()
  private mtime = -1

  constructor(private file: string) {}

  private read(): string[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{8,36}$/i.test(x)) : []
    } catch {
      return []
    }
  }

  /** The ids now (the file is read again when it changed). */
  ids(): Set<string> {
    let m = -2
    try {
      m = statSync(this.file).mtimeMs
    } catch {
      // none yet
    }
    if (m !== this.mtime) {
      this.mtime = m
      this.set = new Set(this.read())
    }
    return this.set
  }

  add(ids: string[]): void {
    const all = [...new Set([...this.read(), ...ids.filter(Boolean)])].slice(-KEEP)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(all))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`superseded sessions: ${String(e)}`)
    }
    this.mtime = -1
  }
}
