import { ACTIVITY_COALESCE_MS, ACTIVITY_GROUPS } from '@shared/activityLog'

export type TimelineRange = 'today' | 'yesterday' | '7d'

/** The Timeline's filters, kept per device in `md.dashboard.timeline`. */
export interface TimelineFilters {
  range: TimelineRange
  /** ActivityGroup ids; empty: All. */
  groups: string[]
  account: string | null
  repo: string | null
}

export const DEFAULT_TIMELINE: TimelineFilters = { range: 'today', groups: [], account: null, repo: null }

/** A saved value, checked: anything unreadable is the default. */
export function cleanTimeline(raw: unknown): TimelineFilters {
  if (!raw || typeof raw !== 'object') return DEFAULT_TIMELINE
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : null)
  const known = new Set(ACTIVITY_GROUPS.map((g) => g.id as string))
  return {
    range: r.range === 'yesterday' || r.range === '7d' ? r.range : 'today',
    groups: Array.isArray(r.groups) ? [...new Set(r.groups.filter((g): g is string => typeof g === 'string' && known.has(g)))] : [],
    account: str(r.account),
    repo: str(r.repo),
  }
}

/**
 * How far back the log can record an event when it is first seen: up to an hour (a merge read
 * late), and a coalesced event moves by up to ACTIVITY_COALESCE_MS on top of that.
 */
export const ACTIVITY_LATE_MS = 60 * 60_000 + ACTIVITY_COALESCE_MS

/**
 * Where an incremental read on activity:changed starts: 15 minutes before the newest event shown
 * (a coalesced event moves later and keeps its id), or further back when that is later than an
 * hour and a quarter before now (an event backdated by up to an hour), never before the range's start.
 */
export function timelineSince(from: number, newest: number | undefined, now: number): number {
  return Math.max(from, Math.min((newest ?? from) - ACTIVITY_COALESCE_MS, now - ACTIVITY_LATE_MS))
}
