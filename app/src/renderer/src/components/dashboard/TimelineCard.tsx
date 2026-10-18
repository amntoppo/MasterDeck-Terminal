import { memo, useMemo, useState } from 'react'
import { ACTIVITY_GROUPS, ACTIVITY_LIST_MAX, TYPE_TAG, activityRows, filterActivity, type ActivityEvent } from '@shared/activityLog'
import { Card } from './Card'
import { go, type DashNav } from './nav'

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

const RANGES: { id: TimelineRange; label: string; words: string }[] = [
  { id: 'today', label: 'Today', words: 'today' },
  { id: 'yesterday', label: 'Yesterday', words: 'yesterday' },
  { id: '7d', label: '7 days', words: 'in 7 days' },
]

const PAGE = 200
const TAG_CLASS: Record<string, string> = { SES: 'ses', PR: 'pr', TKT: 'tkt', GIT: 'git', RUN: 'run', NOTE: 'note', YOU: 'you' }
const hm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dateWords = (t: number) => {
  const d = new Date(t)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** Timeline (#183): what happened on this Mac, from the activity log, newest first. */
export const TimelineCard = memo(function TimelineCard({
  events,
  filters,
  onFilters,
  now,
  nav,
  from,
  recordingSince,
}: {
  /** The range's events, newest first; null while read. */
  events: ActivityEvent[] | null
  filters: TimelineFilters
  onFilters: (f: TimelineFilters) => void
  now: number
  nav: DashNav
  /** Where the range starts (ms). */
  from: number
  /** When this device first showed the Dashboard: the log has nothing from before it. */
  recordingSince: number | null
}) {
  const [shown, setShown] = useState(PAGE)
  const set = (p: Partial<TimelineFilters>) => {
    setShown(PAGE)
    onFilters({ ...filters, ...p })
  }
  const accounts = useMemo(() => [...new Set((events ?? []).flatMap((e) => (e.account ? [e.account] : [])))].sort(), [events])
  const repos = useMemo(() => [...new Set((events ?? []).flatMap((e) => (e.repo ? [e.repo] : [])))].sort(), [events])
  const list = useMemo(() => filterActivity(events ?? [], { groups: filters.groups, account: filters.account, repo: filters.repo }), [events, filters.groups, filters.account, filters.repo])
  const days = useMemo(() => activityRows(list.slice(0, shown), now), [list, shown, now])
  const range = RANGES.find((r) => r.id === filters.range) ?? RANGES[0]
  const filtered = filters.groups.length > 0 || !!filters.account || !!filters.repo
  const full = (events?.length ?? 0) >= ACTIVITY_LIST_MAX

  let empty: string | null = null
  if (events && !list.length) {
    if (filtered && events.length) empty = 'Nothing of this kind happened in this range.'
    else if (recordingSince !== null && from < recordingSince && now - recordingSince < 7 * 86_400_000) empty = `The timeline starts recording on ${dateWords(recordingSince)}.`
    else if (filters.range === 'today') empty = 'Nothing happened yet today.'
    else empty = filtered ? 'Nothing of this kind happened in this range.' : 'Nothing happened in this range.'
  }

  const chip = (id: string | null, label: string) => {
    const on = id === null ? filters.groups.length === 0 : filters.groups.includes(id)
    return (
      <button
        key={id ?? 'all'}
        className={`dash-fchip${on ? ' on' : ''}`}
        aria-pressed={on}
        onClick={() => set({ groups: id === null ? [] : on ? filters.groups.filter((g) => g !== id) : [...filters.groups, id] })}
      >
        {label}
      </button>
    )
  }
  const pick = (have: string[], cur: string | null) => (cur && !have.includes(cur) ? [cur, ...have] : have).map((x) => <option key={x} value={x}>{x}</option>)

  return (
    <Card
      id="timeline"
      title="Timeline"
      count={events ? `${full ? `${list.length}+` : list.length} ${range.words}` : null}
      countTip={`Events recorded ${range.words} on this Mac${filtered ? ', of the kinds picked' : ''}`}
      loading={events === null}
    >
      <div className="dash-tfil" role="group" aria-label="Kinds">
        {chip(null, 'All')}
        {ACTIVITY_GROUPS.map((g) => chip(g.id, g.label))}
      </div>
      <div className="dash-tfil">
        <div className="seg dash-seg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.id} className={filters.range === r.id ? 'on' : ''} aria-pressed={filters.range === r.id} onClick={() => set({ range: r.id })}>
              {r.label}
            </button>
          ))}
        </div>
        <label className="dash-sub">
          Account{' '}
          <select className="dash-sel" value={filters.account ?? ''} onChange={(e) => set({ account: e.target.value || null })}>
            <option value="">All accounts</option>
            {pick(accounts, filters.account)}
          </select>
        </label>
        <label className="dash-sub">
          Repo{' '}
          <select className="dash-sel" value={filters.repo ?? ''} onChange={(e) => set({ repo: e.target.value || null })}>
            <option value="">All repos</option>
            {pick(repos, filters.repo)}
          </select>
        </label>
      </div>
      {empty ? (
        <div className="dash-empty">{empty}</div>
      ) : (
        <div className="dash-feed">
          {days.map((d) => (
            <div key={d.key}>
              <div className="dash-day">{d.label}</div>
              {d.events.map((e) => {
                const tag = TYPE_TAG[e.type]
                const body = (
                  <>
                    <span className="dash-evt dash-mono" title={new Date(e.at).toLocaleString()}>
                      {hm(e.at)}
                    </span>
                    <span className={`dash-tag dash-k-${TAG_CLASS[tag]}`}>{tag}</span>
                    <span className="dash-evbody">
                      <span className="dash-evx">{e.title}</span>
                      {e.detail && <span className="dash-evm">{e.detail}</span>}
                    </span>
                  </>
                )
                const target = e.target
                return target ? (
                  <button key={e.id} className="dash-ev" onClick={() => go(nav, target)}>
                    {body}
                  </button>
                ) : (
                  <div key={e.id} className="dash-ev">
                    {body}
                  </div>
                )
              })}
            </div>
          ))}
          {list.length > shown && (
            <button className="dash-more dash-showmore" onClick={() => setShown((n) => n + PAGE)} title={`${list.length - shown} more events in this range`}>
              Show more
            </button>
          )}
        </div>
      )}
    </Card>
  )
})
