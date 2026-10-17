import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Notice } from '@shared/inbox'
import { NOTIFY_TYPES } from '@shared/notifications'

/** A notice this old goes (the inbox then resolves it); at most this many are kept. */
export const NOTICE_KEEP_MS = 3 * 86_400_000
export const NOTICE_MAX = 50

const TYPES = new Set<string>(NOTIFY_TYPES.map((t) => t.id))
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

function asNotice(v: unknown): Notice | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!text(o.id, 200) || !o.id.startsWith('event:') || !TYPES.has(o.type as string)) return null
  if (!text(o.title, 300) || !text(o.body, 2000)) return null
  if (o.sessionKey !== null && !text(o.sessionKey, 200)) return null
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || o.at <= 0) return null
  return { id: o.id, type: o.type as Notice['type'], title: o.title, body: o.body, sessionKey: o.sessionKey, at: o.at }
}

/**
 * Events the user routed to Needs you (Settings → Notifications: session finished, PR merged…),
 * in MASTERDECK_HOME/notices.json (atomically). The inbox makes them items (shared/inbox.ts); Done
 * dismisses one there, and it goes from here when it expires.
 */
export class Notices {
  private items: Notice[] = []
  private seq = 0

  constructor(
    private file: string,
    private onChange: () => void = () => {},
    private now: () => number = Date.now,
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (Array.isArray(raw)) this.items = raw.map(asNotice).filter((n): n is Notice => !!n)
    } catch {
      // none yet, or not ours: start empty (the next write replaces it)
    }
  }

  list(): Notice[] {
    const since = this.now() - NOTICE_KEEP_MS
    return this.items.filter((n) => n.at >= since)
  }

  add(n: Omit<Notice, 'id' | 'at'>): Notice | null {
    const at = this.now()
    const ok = asNotice({ ...n, title: n.title.slice(0, 300), body: n.body.slice(0, 2000), id: `event:${n.type}:${at}:${this.seq++}`, at })
    if (!ok) return null
    this.items = [ok, ...this.list()].slice(0, NOTICE_MAX)
    this.save()
    this.onChange()
    return ok
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.items, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      rmSync(tmp, { force: true })
      console.error(`notices: ${String(e)}`)
    }
  }
}
