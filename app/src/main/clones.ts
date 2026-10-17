import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseClones, type CloneRecord } from '@shared/clone'
import type { Session } from '@shared/types'

/** ponytail: the newest records only; a clone older than this loses its "Cloned from" line and is filtered no more. */
const KEEP = 500
const PENDING_MS = 10 * 60_000

/** `session-clones.json`: the sessions Clone started, by their background id (see shared/clone.ts). */
export class CloneStore {
  private recs: Record<string, CloneRecord> = {}
  private mtime = -1
  /** Clones whose bg id claude did not print: claimed by name once listed. */
  private pending = new Map<string, CloneRecord>()

  constructor(private file: string) {}

  private all(): Record<string, CloneRecord> {
    let m = -2
    try {
      m = statSync(this.file).mtimeMs
    } catch {
      // none yet
    }
    if (m !== this.mtime) {
      this.mtime = m
      try {
        this.recs = parseClones(JSON.parse(readFileSync(this.file, 'utf8')))
      } catch {
        this.recs = {}
      }
    }
    return this.recs
  }

  get(bg: string | null | undefined): CloneRecord | null {
    return bg ? (this.all()[bg] ?? null) : null
  }

  add(bg: string, rec: CloneRecord): void {
    const next = { ...this.all() }
    delete next[bg]
    next[bg] = rec
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[k]
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 1))
      renameSync(`${this.file}.tmp`, this.file)
      this.recs = next
      this.mtime = statSync(this.file).mtimeMs
    } catch (e) {
      console.error(`session clones: ${String(e)}`)
    }
  }

  expect(name: string, rec: CloneRecord): void {
    this.pending.set(name, rec)
  }

  /** Record a clone started by name once `claude agents` lists it (a background session newer than the clone). */
  claim(sessions: Pick<Session, 'bgId' | 'name' | 'state' | 'startedAt' | 'kind'>[], now = Date.now()): void {
    for (const [name, rec] of this.pending) {
      const s = sessions.find((x) => x.kind === 'background' && x.bgId && x.name === name && x.state !== 'done' && x.startedAt >= rec.at - 10_000)
      if (s?.bgId) {
        this.pending.delete(name)
        this.add(s.bgId, rec)
      } else if (now - rec.at > PENDING_MS) this.pending.delete(name)
    }
  }

  /** Clones started with Keep ticket link that are not linked yet. */
  toLink(): [string, CloneRecord & { ticket: NonNullable<CloneRecord['ticket']> }][] {
    return Object.entries(this.all()).filter((e): e is [string, CloneRecord & { ticket: NonNullable<CloneRecord['ticket']> }] => !!e[1].ticket && !e[1].linked)
  }

  markLinked(bg: string): void {
    const r = this.get(bg)
    if (r) this.add(bg, { ...r, linked: true })
  }
}
