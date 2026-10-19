import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ACTIVITY_GROUPS, ACTIVITY_LIST_MAX, TYPE_TAG, activityRows, filterActivity, type ActivityEvent } from '@shared/activityLog'
import { Card } from './Card'
import { go, type DashNav } from './nav'
import type { TimelineFilters, TimelineRange } from './timeline'

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
  compact,
  error,
  onRetry,
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
  /** The phone or a narrow window: the kinds and the selects move into a sheet. */
  compact?: boolean
  /** The range could not be read (and nothing of it is shown). */
  error?: string | null
  onRetry?: () => void
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
  const picked = filters.groups.length + (filters.account ? 1 : 0) + (filters.repo ? 1 : 0)
  const pick = (have: string[], cur: string | null) => (cur && !have.includes(cur) ? [cur, ...have] : have).map((x) => <option key={x} value={x}>{x}</option>)

  return (
    <Card
      id="timeline"
      title="Timeline"
      count={events ? `${full ? `${list.length}+` : list.length} ${range.words}` : null}
      countTip={`Events recorded ${range.words} on this Mac${filtered ? ', of the kinds picked' : ''}`}
      loading={events === null && !error}
    >
      {!compact && (
        <div className="dash-tfil" role="group" aria-label="Kinds">
          {chip(null, 'All')}
          {ACTIVITY_GROUPS.map((g) => chip(g.id, g.label))}
        </div>
      )}
      <div className="dash-tfil">
        <div className="seg dash-seg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.id} className={filters.range === r.id ? 'on' : ''} aria-pressed={filters.range === r.id} onClick={() => set({ range: r.id })}>
              {r.label}
            </button>
          ))}
        </div>
        {compact ? (
          <FilterSheet picked={picked} onReset={() => set({ groups: [], account: null, repo: null })}>
            <div className="dash-tfil" role="group" aria-label="Kinds">
              {chip(null, 'All')}
              {ACTIVITY_GROUPS.map((g) => chip(g.id, g.label))}
            </div>
            <label htmlFor="dash-tl-account">Account</label>
            <select id="dash-tl-account" className="dash-sel" value={filters.account ?? ''} onChange={(e) => set({ account: e.target.value || null })}>
              <option value="">All accounts</option>
              {pick(accounts, filters.account)}
            </select>
            <label htmlFor="dash-tl-repo">Repo</label>
            <select id="dash-tl-repo" className="dash-sel" value={filters.repo ?? ''} onChange={(e) => set({ repo: e.target.value || null })}>
              <option value="">All repos</option>
              {pick(repos, filters.repo)}
            </select>
          </FilterSheet>
        ) : (
          <>
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
          </>
        )}
      </div>
      {error ? (
        <div className="dash-empty" title={error}>
          Could not read the timeline ·{' '}
          <button className="dash-more" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : empty ? (
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

/**
 * The phone's "Filter · All" button and its sheet (the Board's and PRs' sheet styles, PhoneFilters):
 * the kinds and the selects, which act at once; Done, ×, Esc or a press outside close it. A modal
 * dialog: focus moves into it when it opens and back to the button when it closes.
 */
function FilterSheet({ picked, onReset, children }: { picked: number; onReset: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) button.current?.focus()
      wasOpen.current = false
      return
    }
    wasOpen.current = true
    sheet.current?.querySelector<HTMLElement>('.filters-sheet-body button, .filters-sheet-body select')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      <button ref={button} className={`btn dash-filterbtn${picked ? ' active' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} title={picked ? `${picked} filter${picked === 1 ? '' : 's'} on` : 'Every kind, account and repo'}>
        Filter · {picked ? picked : 'All'}
      </button>
      {open &&
        createPortal(
          <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
            <div ref={sheet} className="dialog filters-sheet dash-tl-sheet" role="dialog" aria-modal="true" aria-label="Timeline filters">
              <h3>
                Timeline filters
                <span style={{ flex: 1 }} />
                <button className="icon-btn" onClick={() => setOpen(false)} title="Close (Esc)" aria-label="Close">
                  ×
                </button>
              </h3>
              <div className="filters-sheet-body">{children}</div>
              <div className="foot">
                <button className="btn" onClick={onReset} disabled={!picked}>
                  Reset
                </button>
                <span className="grow" />
                <button className="btn primary" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
