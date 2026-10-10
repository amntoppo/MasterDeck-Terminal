import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MEETING_ERROR_MAX, MEETING_ID, MEETING_NOTICE_KINDS, MEETING_TITLE_MAX, type MeetingNotice } from '@shared/meetings'

/** An item this old goes (the inbox then resolves it). */
const KEEP_MS = 30 * 86_400_000
const MAX = 100
// eslint-disable-next-line no-control-regex
const LINE_CONTROL = /[\x00-\x1f\x7f-\x9f]/

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000

function asNotice(v: unknown): MeetingNotice | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.meetingId !== 'string' || !MEETING_ID.test(o.meetingId)) return null
  if (typeof o.title !== 'string' || o.title.length > MEETING_TITLE_MAX || LINE_CONTROL.test(o.title)) return null
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || o.at <= 0) return null
  if (!MEETING_NOTICE_KINDS.includes(o.kind as MeetingNotice['kind'])) return null
  if (o.kind === 'added') {
    if (!count(o.sessions) || !count(o.tickets)) return null
    return { meetingId: o.meetingId, title: o.title, at: o.at, kind: 'added', sessions: o.sessions, tickets: o.tickets }
  }
  if (typeof o.reason !== 'string' || o.reason.length > MEETING_ERROR_MAX || LINE_CONTROL.test(o.reason)) return null
  return { meetingId: o.meetingId, title: o.title, at: o.at, kind: o.kind as 'unmatched' | 'failed', reason: o.reason }
}

/**
 * Meetings' Needs-you items (spec §10), one per meeting, in MASTERDECK_HOME/meeting-notices.json
 * (atomically). Outside main/meetings/ on purpose: Sources reads it on every build, and reading a
 * small file asks macOS nothing. The inbox makes the items (shared/inbox.ts meetingItem); an action
 * or a newer notice for the meeting clears it, and the inbox resolves the item.
 */
export class MeetingNotices {
  private items: MeetingNotice[] = []

  constructor(
    private file: string,
    private onChange: () => void = () => {},
    private now: () => number = Date.now,
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (Array.isArray(raw)) this.items = raw.map(asNotice).filter((n): n is MeetingNotice => !!n)
    } catch {
      // none yet, or not ours: start empty (the next write replaces it)
    }
  }

  list(): MeetingNotice[] {
    const since = this.now() - KEEP_MS
    return this.items.filter((n) => n.at >= since)
  }

  /** The meeting's notice, in place of the one it had. A checked copy only: a bad one is not kept. */
  set(n: MeetingNotice): void {
    const ok = asNotice(n)
    if (!ok) return
    const had = this.items.find((x) => x.meetingId === ok.meetingId)
    if (had && JSON.stringify({ ...had, at: 0 }) === JSON.stringify({ ...ok, at: 0 })) return
    this.items = [ok, ...this.items.filter((x) => x.meetingId !== ok.meetingId)].slice(0, MAX)
    this.save()
  }

  /** The meeting's notice goes (all kinds, or only this one). True when one went. */
  clear(meetingId: string, kind?: MeetingNotice['kind']): boolean {
    const next = this.items.filter((x) => x.meetingId !== meetingId || (kind !== undefined && x.kind !== kind))
    if (next.length === this.items.length) return false
    this.items = next
    this.save()
    return true
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.items, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
      console.error(`meetings: could not save the Needs-you items: ${String((e as { code?: string })?.code ?? 'error')}`)
    }
    try {
      this.onChange()
    } catch (e) {
      console.error('meetings: notices onChange failed', e)
    }
  }
}
