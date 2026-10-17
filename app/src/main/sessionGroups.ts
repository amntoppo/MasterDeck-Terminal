import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CliResult } from '@shared/types'
import { applyGroupOp, carryGroup, emptyGroups, parseGroups, pruneGroups, type SessionGroups } from '@shared/sessionGroups'

/** session-groups.json: the session list's tabs and which session is in which (Session.key). */
export class SessionGroupStore {
  private d: SessionGroups = emptyGroups()
  private loaded = false
  private missingSince = new Map<string, number>()

  constructor(readonly file: string, private readonly now: () => number = Date.now) {}

  private load(): SessionGroups {
    if (this.loaded) return this.d
    this.loaded = true
    if (!existsSync(this.file)) return this.d
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      raw = null
    }
    const d = parseGroups(raw)
    if (d) return (this.d = d)
    try {
      renameSync(this.file, `${this.file}.corrupt-${this.now()}`)
    } catch {
      // leave it; the next save overwrites
    }
    return this.d
  }

  all(): SessionGroups {
    return this.load()
  }

  /** One change from the tab bar or a session's menu (see applyGroupOp). */
  act(op: unknown): CliResult & { id?: string } {
    const r = applyGroupOp(this.load(), op)
    if (!r.ok) return r
    if (r.groups !== this.d) {
      const was = this.d
      this.d = r.groups
      if (!this.save()) {
        this.d = was
        return { ok: false, message: 'Could not save the tabs.' }
      }
    }
    return { ok: true, message: 'saved', ...(r.id ? { id: r.id } : {}) }
  }

  /** A resume made a copy: it keeps the old session's tab. */
  carry(oldKey: string, newKey: string): void {
    const next = carryGroup(this.load(), oldKey, newKey)
    if (next === this.d) return
    this.d = next
    this.save()
  }

  /** Forget sessions missing from a real session list for a while (shared/sessionGroups pruneGroups). */
  prune(listed: Set<string>): void {
    const next = pruneGroups(this.load(), listed, this.missingSince, this.now())
    if (next === this.d) return
    this.d = next
    this.save()
  }

  private save(): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, ...this.d }, null, 2))
      renameSync(`${this.file}.tmp`, this.file)
      return true
    } catch (e) {
      console.error(`session groups: could not write ${this.file}: ${String(e)}`)
      return false
    }
  }
}
