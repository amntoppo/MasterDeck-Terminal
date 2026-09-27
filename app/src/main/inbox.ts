import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { allowed, RESOLVED_BECAUSE, type InboxEntry, type InboxItem, type InboxView } from '@shared/inbox'
import type { CliResult } from '@shared/types'

/** Resolved items kept this long, at most this many. */
const HISTORY_MS = 7 * 86_400_000
const HISTORY_MAX = 400
/** The event log keeps its last lines. */
const LOG_KEEP = 2000

export type InboxEvent =
  | { type: 'added'; entry: InboxEntry }
  | { type: 'resolved'; entry: InboxEntry }
  | { type: 'action'; entry: InboxEntry; action: string; ok: boolean; message: string; by: string }

/** Carries out an item's action (types into the session, approves the proposal…). */
export type ActionRunner = (item: InboxItem, type: string, payload: Record<string, unknown>) => Promise<CliResult>

/**
 * The Needs-you inbox: the items `collectItems` finds each time the state is built, with what the
 * user did about them (dismissed, snoozed, acted) and what happened (resolved, and why). Saved to
 * `inbox.json`; every addition, resolution and action is also appended to `inbox-events.jsonl`, and
 * emitted, so notifications (and later a phone) follow the same events.
 */
export class Inbox extends EventEmitter {
  private entries = new Map<string, InboxEntry>()
  private dirty = false
  private saveTimer: NodeJS.Timeout | null = null

  constructor(
    private file: string,
    private logFile: string,
    private now: () => number = () => Date.now(),
  ) {
    super()
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: InboxEntry[] }
      for (const e of raw.entries ?? []) if (e?.item?.id && e.state) this.entries.set(e.item.id, e)
    } catch {
      // none yet, or unreadable: start empty
    }
    try {
      const lines = readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean)
      if (lines.length > LOG_KEEP) writeFileSync(this.logFile, lines.slice(-LOG_KEEP).join('\n') + '\n')
    } catch {
      // no log yet
    }
  }

  private save(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 500)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ entries: [...this.entries.values()] }))
      renameSync(tmp, this.file)
    } catch {
      // the next change writes it again
    }
  }

  private log(e: InboxEvent): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true })
      const { entry, ...rest } = e
      appendFileSync(this.logFile, JSON.stringify({ at: this.now(), ...rest, id: entry.item.id, kind: entry.item.kind, how: entry.resolvedHow ?? undefined }) + '\n')
    } catch {
      // best effort
    }
    this.emit('event', e)
  }

  /**
   * The items there are now. New ones open (and are announced, unless `silent`: the builds after
   * starting, before sessions and the ledger are loaded, whose items may be old); ones that went
   * away resolve, with why (never while `silent`: a half-loaded state is not a resolution); a snooze
   * that ran out opens again. Returns true when anything changed.
   */
  update(items: InboxItem[], silent = false): boolean {
    const now = this.now()
    let changed = false
    const present = new Set<string>()
    for (const item of items) {
      present.add(item.id)
      const e = this.entries.get(item.id)
      if (!e) {
        const entry: InboxEntry = { item, state: 'open', firstSeen: now, lastSeen: now }
        this.entries.set(item.id, entry)
        changed = true
        if (!silent) this.log({ type: 'added', entry })
        continue
      }
      if (JSON.stringify(e.item) !== JSON.stringify(item)) changed = true
      e.item = item
      e.lastSeen = now
      if (e.state === 'resolved') {
        Object.assign(e, { state: 'open', resolvedAt: null, resolvedHow: null })
        changed = true
        if (!silent) this.log({ type: 'added', entry: e })
      } else if (e.state === 'snoozed' && (e.snoozedUntil ?? 0) <= now) {
        Object.assign(e, { state: 'open', snoozedUntil: null })
        changed = true
      }
    }
    for (const e of this.entries.values()) {
      if (silent || e.state === 'resolved' || present.has(e.item.id)) continue
      const acted = e.lastAction && e.lastAction.ok && now - e.lastAction.at < 30 * 60_000 ? e.lastAction : null
      e.resolvedHow = e.state === 'dismissed' ? 'dismissed' : acted ? `${acted.message || acted.type} (${acted.by})` : RESOLVED_BECAUSE[e.item.kind]
      e.state = 'resolved'
      e.resolvedAt = now
      changed = true
      this.log({ type: 'resolved', entry: e })
    }
    for (const [id, e] of this.entries)
      if (e.state === 'resolved' && now - (e.resolvedAt ?? 0) > HISTORY_MS) {
        this.entries.delete(id)
        changed = true
      }
    const resolved = [...this.entries.values()].filter((e) => e.state === 'resolved').sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    for (const e of resolved.slice(HISTORY_MAX)) this.entries.delete(e.item.id)
    if (changed) this.save()
    return changed
  }

  /**
   * Do something about an item: dismiss it (hidden until the situation changes), snooze it, bring
   * it back, or one of its actions, carried out by `run` after checking the item is still open.
   */
  async act(id: string, type: string, payload: Record<string, unknown>, run: ActionRunner): Promise<CliResult> {
    const e = this.entries.get(id)
    if (!e || e.state === 'resolved') return { ok: false, message: 'that is no longer waiting on you' }
    const by = typeof payload.by === 'string' && payload.by ? payload.by.slice(0, 40) : 'desktop'
    let r: CliResult
    if (type === 'dismiss') {
      e.state = 'dismissed'
      r = { ok: true, message: 'dismissed' }
    } else if (type === 'snooze') {
      const minutes = typeof payload.minutes === 'number' && payload.minutes > 0 ? Math.min(payload.minutes, 7 * 24 * 60) : 60
      Object.assign(e, { state: 'snoozed', snoozedUntil: this.now() + minutes * 60_000 })
      r = { ok: true, message: `snoozed for ${minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`}` }
    } else if (type === 'wake') {
      Object.assign(e, { state: 'open', snoozedUntil: null })
      r = { ok: true, message: 'back' }
    } else {
      if (e.state !== 'open') return { ok: false, message: 'it is snoozed or dismissed; bring it back first' }
      if (!allowed(e.item, type)) return { ok: false, message: `${type} is not an action for this item` }
      r = await run(e.item, type, payload)
    }
    e.lastAction = { type, at: this.now(), ok: r.ok, message: r.message, by }
    this.log({ type: 'action', entry: e, action: type, ok: r.ok, message: r.message, by })
    this.save()
    return r
  }

  view(): InboxView {
    const all = [...this.entries.values()]
    const byPriority = (a: InboxEntry, b: InboxEntry) => b.item.priority - a.item.priority || b.firstSeen - a.firstSeen
    const since = this.now() - 86_400_000
    return {
      open: all.filter((e) => e.state === 'open').sort(byPriority),
      snoozed: all.filter((e) => e.state === 'snoozed').sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0)),
      history: all
        .filter((e) => e.state === 'resolved' && (e.resolvedAt ?? 0) >= since)
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
        .slice(0, 50),
    }
  }

  get(id: string): InboxEntry | undefined {
    return this.entries.get(id)
  }
}
