import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ACTIVITY_KEEP_DAYS,
  ACTIVITY_LIST_MAX,
  ACTIVITY_MAX_LINES,
  cleanEvent,
  coalesce,
  type ActivityEvent,
} from '@shared/activityLog'

const KEEP_MS = ACTIVITY_KEEP_DAYS * 86_400_000
const CHANGE_MS = 2_000
const ERROR_EVERY_MS = 60_000

export interface ActivityLogOptions {
  now?: () => number
  /** Called at most once per 2 s after events were added (main emits CH.activityChanged). */
  onChange?: () => void
  /** Runs `fn` after `ms`; injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => void
}

const defaultTimer = (fn: () => void, ms: number) => {
  setTimeout(fn, ms).unref?.()
}

/** An error's code, never its message: Node's messages carry the path. */
const reason = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? 'error'

/**
 * The Dashboard's activity log (#183) in MASTERDECK_HOME/activity.jsonl: one event per line,
 * appended. The file is trimmed (14 days, 5000 lines) and cleaned only on load, then rewritten
 * atomically. In memory the events are kept newest first, coalesced and bounded the same way.
 * Nothing here throws into a caller: a failed write is logged (once a minute) and dropped.
 */
export class ActivityLog {
  /** Newest first. */
  private events: ActivityEvent[] = []
  private now: () => number
  private onChange: () => void
  private setTimer: (fn: () => void, ms: number) => void
  private lastChange = -Infinity
  private changePending = false
  private lastError = -Infinity

  constructor(
    private file: string,
    opts: ActivityLogOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.onChange = opts.onChange ?? (() => {})
    this.setTimer = opts.setTimer ?? defaultTimer
    try {
      this.load()
    } catch (e) {
      this.events = []
      this.fail('load', e)
    }
  }

  get size(): number {
    return this.events.length
  }

  add(raw: ActivityEvent): void {
    try {
      const e = cleanEvent(raw)
      if (!e) return
      this.events = this.bound(coalesce(this.events, e))
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        appendFileSync(this.file, JSON.stringify(e) + '\n')
      } catch (err) {
        this.fail('write', err)
      }
      this.changed()
    } catch (err) {
      this.fail('add', err)
    }
  }

  /** Events with since ≤ at ≤ until, newest first, at most `limit` (and never more than 1000). */
  list(since: number, until: number, limit = ACTIVITY_LIST_MAX): ActivityEvent[] {
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) return []
    const max = Math.max(0, Math.min(Number.isFinite(limit) ? Math.floor(limit) : ACTIVITY_LIST_MAX, ACTIVITY_LIST_MAX))
    const out: ActivityEvent[] = []
    for (const e of this.events) {
      if (out.length >= max) break
      if (e.at > until) continue
      if (e.at < since) break
      out.push(e)
    }
    return out
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (e) {
      if (reason(e) !== 'ENOENT') this.fail('read', e)
      return
    }
    const rows = text.split('\n').filter((l) => l.trim())
    const cutoff = this.now() - KEEP_MS
    const read: ActivityEvent[] = []
    for (const line of rows) {
      let e: ActivityEvent | null = null
      try {
        e = cleanEvent(JSON.parse(line))
      } catch {
        // a corrupt line: skipped, and the rewrite below drops it
      }
      if (e && e.at >= cutoff) read.push(e)
    }
    // Oldest first through coalesce, so a newer line replaces the one it repeats.
    read.sort((a, b) => a.at - b.at)
    let list: ActivityEvent[] = []
    for (const e of read.slice(-ACTIVITY_MAX_LINES)) list = coalesce(list, e)
    this.events = list
    // Rewritten whenever the file holds anything memory does not (trimmed, corrupt or coalesced lines).
    if (list.length !== rows.length) this.rewrite()
  }

  private rewrite(): void {
    const tmp = `${this.file}.tmp`
    try {
      const body = [...this.events].reverse().map((e) => JSON.stringify(e) + '\n').join('')
      writeFileSync(tmp, body)
      renameSync(tmp, this.file)
    } catch (e) {
      this.fail('rewrite', e)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // nothing more to do
      }
    }
  }

  /** Memory holds what a load would keep: 14 days, 5000 events. */
  private bound(list: ActivityEvent[]): ActivityEvent[] {
    const cutoff = this.now() - KEEP_MS
    let end = Math.min(list.length, ACTIVITY_MAX_LINES)
    while (end > 0 && list[end - 1].at < cutoff) end--
    return end === list.length ? list : list.slice(0, end)
  }

  private changed(): void {
    if (this.changePending) return
    const wait = this.lastChange + CHANGE_MS - this.now()
    if (wait <= 0) return this.fire()
    this.changePending = true
    this.setTimer(() => {
      this.changePending = false
      this.fire()
    }, wait)
  }

  private fire(): void {
    this.lastChange = this.now()
    try {
      this.onChange()
    } catch (e) {
      this.fail('onChange', e)
    }
  }

  private fail(what: string, e: unknown): void {
    const now = this.now()
    if (now - this.lastError < ERROR_EVERY_MS) return
    this.lastError = now
    console.error(`activity log: ${what} failed (${reason(e)})`)
  }
}
