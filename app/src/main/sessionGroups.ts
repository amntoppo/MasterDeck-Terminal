import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CliResult } from '@shared/types'
import {
  ALL,
  applyGroupOp,
  carryGroup,
  claimWaits,
  emptyGroups,
  parseGroups,
  pruneGroups,
  type GroupWait,
  type SessionGroups,
} from '@shared/sessionGroups'

/** session-groups.json: the session list's tabs and which session is in which (Session.key). */
export class SessionGroupStore {
  private d: SessionGroups = emptyGroups()
  private loaded = false
  private missingSince = new Map<string, number>()
  /** Sessions started into a tab, not listed yet (#171). Memory only: a restart leaves them in All. */
  private waits: GroupWait[] = []

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

  /**
   * A session is being started into `group` (#171): put it there when a poll first lists it.
   * `skip`: keys of live sessions with that name already listed. All or an unknown tab: nothing.
   */
  expect(name: string, group: unknown, skip: string[]): void {
    if (typeof group !== 'string' || group === ALL || !this.load().groups.some((g) => g.id === group)) return
    this.unexpect(name)
    this.waits = [...this.waits, { name, group, skip, at: this.now() }]
  }

  /** The start failed: nothing to wait for. */
  unexpect(name: string): void {
    this.waits = this.waits.filter((w) => w.name !== name)
  }

  /** Put the expected sessions a real session list now has in their tabs (shared/sessionGroups claimWaits). */
  claim(sessions: { key: string; name: string; state: string }[]): void {
    if (!this.waits.length) return
    const r = claimWaits(this.load(), this.waits, sessions, this.now())
    this.waits = r.waits
    if (r.groups === this.d) return
    this.d = r.groups
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
