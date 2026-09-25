import { useEffect, useMemo, useState } from 'react'
import { dailySpend, dayOf, sessionSpendBetween, sessionTotal, sumBetween, ticketSpend } from '@shared/costs'
import { formatCost } from '@shared/format'
import { formatTokens, mergeByDay, tokenSum, tokensBetween, tokenTitle, type TokensByDay } from '@shared/tokens'
import { deck } from '../deck'
import type { AppState, Session } from '@shared/types'

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
}

type Range = 'today' | 'week' | '30d' | 'all'

export function CostsView({ state, onOpenSession }: Props) {
  const [range, setRange] = useState<Range>('week')
  // Tokens per session and day, from the transcripts; the first load reads their history once.
  const [tokens, setTokens] = useState<Record<string, TokensByDay> | null>(null)
  const now = Date.now()
  const today = dayOf(now)
  const from = range === 'today' ? today : range === 'week' ? dayOf(now - 6 * 86_400_000) : range === '30d' ? dayOf(now - 29 * 86_400_000) : '0000-00-00'
  const book = state.costBook
  const bookIds = Object.keys(book).sort().join(',')
  useEffect(() => {
    let alive = true
    void deck()
      .tokensByDay(bookIds ? bookIds.split(',') : [])
      .then((t) => alive && setTokens(t))
    return () => {
      alive = false
    }
  }, [bookIds])
  const allTokens = useMemo(() => mergeByDay(Object.values(tokens ?? {})), [tokens])
  // '…' while counting; '—' for a session whose transcript is gone.
  const tok = (byDay: TokensByDay | undefined, a: string, b: string) => (!tokens ? '…' : !byDay ? '—' : formatTokens(tokenSum(tokensBetween(byDay, a, b))))
  const rangeTok = (byDay: TokensByDay | undefined) => (range === 'all' ? tok(byDay, '0000-00-00', '9999-99-99') : tok(byDay, from, today))
  const daily = useMemo(() => dailySpend(book), [book])
  const days14 = Array.from({ length: 14 }, (_, i) => dayOf(now - (13 - i) * 86_400_000))
  const max14 = Math.max(0.01, ...days14.map((d) => daily[d] ?? 0))

  const sessions = useMemo(
    () =>
      Object.entries(book)
        .map(([id, rec]) => ({ id, rec, spend: range === 'all' ? sessionTotal(rec) : sessionSpendBetween(rec, from, today) }))
        .filter((x) => x.spend > 0.005)
        .sort((a, b) => b.spend - a.spend),
    [book, range, from, today],
  )
  const tickets = useMemo(() => {
    const out = new Map<number, number>()
    for (const x of sessions) if (x.rec.issue !== null) out.set(x.rec.issue, (out.get(x.rec.issue) ?? 0) + x.spend)
    return [...out].sort((a, b) => b[1] - a[1])
  }, [sessions])
  const allTime = ticketSpend(book)
  const ticketTokens = useMemo(() => {
    const out = new Map<number, TokensByDay>()
    for (const [id, rec] of Object.entries(book)) if (rec.issue !== null && tokens?.[id]) out.set(rec.issue, mergeByDay([out.get(rec.issue) ?? {}, tokens[id]]))
    return out
  }, [book, tokens])
  const cap = state.settings.budgetPerTicketUsd
  const titles = new Map<number, string>([...state.issues.map((i) => [i.number, i.title] as [number, string]), ...(state.board?.cards ?? []).map((c) => [c.number, c.title] as [number, string])])
  const untracked = state.sessions.filter((s) => s.state !== 'done' && !state.allStats[s.sessionId]).length

  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>Costs</h2>
        <span className="muted">
          from the status line hook, tokens from the transcripts{tokens ? '' : ' (counting…)'} · {Object.keys(book).length} sessions recorded · spend a session had before MasterDeck first saw it counts in All time and per ticket, not per day
        </span>
        <span style={{ flex: 1 }} />
        <div className="seg">
          {(['today', 'week', '30d', 'all'] as Range[]).map((r) => (
            <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
              {r === 'today' ? 'Today' : r === 'week' ? '7 days' : r === '30d' ? '30 days' : 'All time'}
            </button>
          ))}
        </div>
      </header>
      <div className="panel-body">
        <div className="kpis">
          <Kpi label="Today" value={formatCost(sumBetween(daily, today, today))} sub={`${tok(allTokens, today, today)} tokens`} />
          <Kpi label="Last 7 days" value={formatCost(sumBetween(daily, dayOf(now - 6 * 86_400_000), today))} sub={`${tok(allTokens, dayOf(now - 6 * 86_400_000), today)} tokens`} />
          <Kpi label="Last 30 days" value={formatCost(sumBetween(daily, dayOf(now - 29 * 86_400_000), today))} sub={`${tok(allTokens, dayOf(now - 29 * 86_400_000), today)} tokens`} />
          <Kpi label="Sessions without cost data" value={String(untracked)} hint="no status line file yet" />
        </div>
        <h3 className="sec">Last 14 days</h3>
        <div className="bars" role="img" aria-label="Spend per day, last 14 days">
          {days14.map((d) => {
            const v = daily[d] ?? 0
            return (
              <div key={d} className="bar-col" title={`${d}: ${formatCost(v)}${tokens ? `\n${tokenTitle(tokensBetween(allTokens, d, d))}` : ''}`}>
                <span className="bar-val">{v > 0 ? formatCost(v) : ''}</span>
                <span className={`bar-fill ${d === today ? 'today' : ''}`} style={{ height: `${Math.max(2, (v / max14) * 100)}%` }} />
                <span className="bar-day">{d.slice(8)}</span>
              </div>
            )
          })}
        </div>
        <div className="two-col">
          <div>
            <h3 className="sec">By ticket</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th className="r">In range</th>
                  <th className="r">Tokens</th>
                  <th className="r">All time</th>
                </tr>
              </thead>
              <tbody>
                {tickets.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No ticket spend in this range.
                    </td>
                  </tr>
                )}
                {tickets.map(([n, v]) => (
                  <tr key={n} className={cap > 0 && (allTime[n] ?? 0) > cap ? 'over' : ''}>
                    <td>
                      #{n} <span className="muted">{titles.get(n) ?? ''}</span>
                    </td>
                    <td className="r">{formatCost(v)}</td>
                    <td className="r muted">{rangeTok(ticketTokens.get(n))}</td>
                    <td className="r">
                      {formatCost(allTime[n] ?? v)}
                      {cap > 0 && (allTime[n] ?? 0) > cap ? ' ⚠' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="sec">By session</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Ticket</th>
                  <th className="r">Spend</th>
                  <th className="r">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No spend in this range.
                    </td>
                  </tr>
                )}
                {sessions.map(({ id, rec, spend }) => {
                  const live = state.sessions.find((s) => s.sessionId === id || s.key === rec.key)
                  return (
                    <tr key={id} className={live ? 'link' : ''} onClick={() => live && onOpenSession(live)} title={live ? 'Open' : id}>
                      <td>
                        {live && <span className={`dot ${live.state}`} />} {rec.name}
                      </td>
                      <td>{rec.issue !== null ? `#${rec.issue}` : '—'}</td>
                      <td className="r">{formatCost(spend)}</td>
                      <td className="r muted" title={tokens?.[id] ? tokenTitle(range === 'all' ? tokensBetween(tokens[id], '0000-00-00', '9999-99-99') : tokensBetween(tokens[id], from, today)) : undefined}>
                        {rangeTok(tokens?.[id])}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  )
}

function Kpi({ label, value, hint, sub }: { label: string; value: string; hint?: string; sub?: string }) {
  return (
    <div className="kpi" title={hint}>
      <div className="kpi-v">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
      <div className="kpi-l">{label}</div>
    </div>
  )
}
