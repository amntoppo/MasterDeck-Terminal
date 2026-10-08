import { useEffect, useMemo, useState } from 'react'
import { parseTicket, ticketKey, ticketLabel } from '@shared/ticket'
import { accountTotals, DEFAULT_IDLE_GAP_MIN, estimateHours, formatHours, hoursCsv, IDLE_GAPS_MIN, UNKNOWN_ACCOUNT, type HoursSession, type SessionActivity } from '@shared/hours'
import { deck, load, save } from '../deck'
import type { AppState } from '@shared/types'

interface Props {
  state: AppState
  /** YYYY-MM-DD, inclusive. */
  from: string
  to: string
}

/**
 * Working hours per account, day and ticket (issue #64): an estimate from when this Mac's sessions
 * were active, worked out by shared/hours.ts. Desktop only (DECK_ACCESS blocks it on the web).
 */
export function HoursView({ state, from, to }: Props) {
  const [gapMin, setGapState] = useState<number>(() => {
    const v = load<number>('hoursIdleGap', DEFAULT_IDLE_GAP_MIN)
    return (IDLE_GAPS_MIN as readonly number[]).includes(v) ? v : DEFAULT_IDLE_GAP_MIN
  })
  const setGap = (v: number) => {
    setGapState(v)
    save('hoursIdleGap', v)
  }
  const [activity, setActivity] = useState<Record<string, SessionActivity> | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState<string | null>(null)
  const book = state.costBook
  const bookIds = Object.keys(book).sort().join(',')
  useEffect(() => {
    let alive = true
    void deck()
      .hoursActivity(bookIds ? bookIds.split(',') : [])
      .then((a) => alive && setActivity(a))
    return () => {
      alive = false
    }
  }, [bookIds])

  const result = useMemo(() => {
    const sessions: HoursSession[] = Object.entries(activity ?? {}).map(([id, a]) => {
      const rec = book[id]
      return { id, account: a.account, ticket: rec && rec.issue !== null ? ticketKey(rec.issueRepo, rec.issue) : null, spans: a.spans }
    })
    return estimateHours(sessions, { idleGapMs: gapMin * 60_000, from, to })
  }, [activity, book, gapMin, from, to])
  const totals = useMemo(() => [...accountTotals(result.accounts)].sort((a, b) => b[1] - a[1]), [result])

  const titles = new Map<string, string>([
    ...state.issues.map((i) => [ticketKey(i.repo, i.number), i.title] as [string, string]),
    ...(state.board?.cards ?? []).map((c) => [ticketKey(c.repo, c.number), c.title] as [string, string]),
  ])
  const labelOf = (k: string) => {
    const t = parseTicket(k)
    return t ? ticketLabel(t.repo, t.number) : k
  }
  const acctName = (a: string | null) => a ?? UNKNOWN_ACCOUNT
  const rowKey = (day: string, a: string | null) => `${day} ${a ?? ''}`
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const exportCsv = async () => {
    const name = `hours-${from === '0000-00-00' ? 'all' : from}-to-${to}.csv`
    const path = await deck().hoursExport(hoursCsv(result), name)
    if (path) setSaved(path)
  }

  return (
    <>
      <p className="hours-rules muted">
        <strong>An estimate, not a time tracker.</strong> Worked out from when sessions on this Mac were active: a gap of up to{' '}
        <select value={gapMin} onChange={(e) => setGap(Number(e.target.value))} aria-label="Idle gap that still counts as working">
          {IDLE_GAPS_MIN.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : `${m / 60} h`}
            </option>
          ))}
        </select>{' '}
        between activity counts as working, a longer one does not. Other machines are not included.
      </p>
      <div className="kpis">
        {activity === null && <Kpi label="Reading transcripts" value="…" />}
        {activity !== null && totals.length === 0 && <Kpi label="No activity in this range" value="0 min" />}
        {totals.map(([a, m]) => (
          <Kpi key={acctName(a)} label={acctName(a)} value={formatHours(m)} hint={a ? undefined : 'Sessions whose GitHub account MasterDeck could not tell'} />
        ))}
      </div>
      <div className="hours-head">
        <h3 className="sec">By account and day</h3>
        <span style={{ flex: 1 }} />
        {saved && <span className="muted" title={saved}>Saved</span>}
        <button className="btn" disabled={result.accounts.length === 0} onClick={() => void exportCsv()} title="date, account, ticket, minutes">
          Export CSV…
        </button>
      </div>
      <table className="tbl hours-tbl">
        <thead>
          <tr>
            <th>Day</th>
            <th>Account</th>
            <th className="r">Hours</th>
          </tr>
        </thead>
        <tbody>
          {result.accounts.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                {activity === null ? 'Reading transcripts…' : 'No session activity in this range.'}
              </td>
            </tr>
          )}
          {result.accounts.map((r) => {
            const k = rowKey(r.day, r.account)
            const tickets = result.tickets.filter((t) => t.day === r.day && t.account === r.account).sort((a, b) => b.minutes - a.minutes)
            const isOpen = open.has(k)
            return [
              <tr key={k} className={tickets.length ? 'link' : ''} onClick={() => tickets.length && toggle(k)} aria-expanded={tickets.length ? isOpen : undefined}>
                <td>
                  <span className="hours-caret">{tickets.length ? (isOpen ? '▾' : '▸') : ''}</span>
                  {r.day}
                </td>
                <td className={r.account ? '' : 'muted'}>{acctName(r.account)}</td>
                <td className="r">{formatHours(r.minutes)}</td>
              </tr>,
              ...(isOpen
                ? tickets.map((t) => (
                    <tr key={`${k} ${t.ticket}`} className="hours-ticket">
                      <td />
                      <td>
                        {labelOf(t.ticket!)} <span className="muted">{titles.get(t.ticket!) ?? ''}</span>
                      </td>
                      <td className="r">{formatHours(t.minutes)}</td>
                    </tr>
                  ))
                : []),
            ]
          })}
        </tbody>
      </table>
      <p className="muted hours-rules">
        A minute worked on two tickets counts for each ticket and once for the account, so a day's tickets can add up to more than its total. Time in a session with no ticket counts for
        the account only.
      </p>
    </>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi" title={hint}>
      <div className="kpi-v">{value}</div>
      <div className="kpi-l">{label}</div>
    </div>
  )
}
