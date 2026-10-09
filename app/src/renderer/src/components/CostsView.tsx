import { useEffect, useMemo, useState } from 'react'
import { parseTicket, ticketKey, ticketLabel } from '@shared/ticket'
import { dailySpend, dayOf, sessionSpendBetween, sessionTotal, sumBetween, ticketSpend } from '@shared/costs'
import { formatCost } from '@shared/format'
import { formatTokens, mergeByDay, tokenSum, tokensBetween, tokenTitle, type TokensByDay } from '@shared/tokens'
import { deck, load, save } from '../deck'
import { can } from '../web'
import { HoursView } from './HoursView'
import type { AppState, Session } from '@shared/types'

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
}

type Range = 'today' | 'week' | '30d' | 'all'
/** What the screen counts: dollars (the status line), tokens or working hours (the transcripts). */
type Unit = 'usd' | 'tokens' | 'hours'

export function CostsView({ state, onOpenSession }: Props) {
  const [range, setRange] = useState<Range>('week')
  // Hours stay on the Mac: the web app has no Hours tab.
  const hoursOk = can('hoursActivity')
  const [unit, setUnitState] = useState<Unit>(() => {
    const u = load<Unit>('costsUnit', 'usd')
    return u === 'hours' && !hoursOk ? 'usd' : u
  })
  const setUnit = (u: Unit) => {
    setUnitState(u)
    save('costsUnit', u)
  }
  const inTokens = unit === 'tokens'
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
  // The chart's value per day, in the chosen unit.
  const dayValue = (d: string) => (inTokens ? tokenSum(tokensBetween(allTokens, d, d)) : (daily[d] ?? 0))
  const max14 = Math.max(inTokens ? 1 : 0.01, ...days14.map(dayValue))
  const fmt = (v: number) => (inTokens ? formatTokens(v) : formatCost(v))

  const tokensIn = (byDay: TokensByDay | undefined) => tokenSum(range === 'all' ? tokensBetween(byDay, '0000-00-00', '9999-99-99') : tokensBetween(byDay, from, today))
  const sessions = useMemo(
    () =>
      Object.entries(book)
        .map(([id, rec]) => ({ id, rec, spend: range === 'all' ? sessionTotal(rec) : sessionSpendBetween(rec, from, today), toks: tokensIn(tokens?.[id]) }))
        .filter((x) => (inTokens ? x.toks > 0 : x.spend > 0.005))
        .sort((a, b) => (inTokens ? b.toks - a.toks : b.spend - a.spend)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book, range, from, today, tokens, inTokens],
  )
  const tickets = useMemo(() => {
    // By ticketKey: two repos can each have a #12.
    const out = new Map<string, number>()
    for (const x of sessions) {
      if (x.rec.issue === null) continue
      const k = ticketKey(x.rec.issueRepo, x.rec.issue)
      out.set(k, (out.get(k) ?? 0) + x.spend)
    }
    return [...out].sort((a, b) => b[1] - a[1])
  }, [sessions])
  const allTime = ticketSpend(book)
  const ticketTokens = useMemo(() => {
    const out = new Map<string, TokensByDay>()
    for (const [id, rec] of Object.entries(book)) {
      if (rec.issue === null || !tokens?.[id]) continue
      const k = ticketKey(rec.issueRepo, rec.issue)
      out.set(k, mergeByDay([out.get(k) ?? {}, tokens[id]]))
    }
    return out
  }, [book, tokens])
  const cap = state.settings.budgetPerTicketUsd
  const titles = new Map<string, string>([
    ...state.issues.map((i) => [ticketKey(i.repo, i.number), i.title] as [string, string]),
    ...(state.board?.cards ?? []).map((c) => [ticketKey(c.repo, c.number), c.title] as [string, string]),
  ])
  const labelOf = (k: string) => {
    const t = parseTicket(k)
    return t ? ticketLabel(t.repo, t.number) : k
  }
  const untracked = state.sessions.filter((s) => s.state !== 'done' && !state.allStats[s.sessionId]).length

  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>Costs</h2>
        <span className="muted">
          {unit === 'hours' ? (
            'estimated working hours per GitHub account, from session activity on this Mac'
          ) : (
            <>
              from the status line hook, tokens from the transcripts{tokens ? '' : ' (counting…)'} · {Object.keys(book).length} sessions recorded · spend a session had before MasterDeck first saw it counts in All time and per ticket, not per day
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <div className="seg unit-seg" role="group" aria-label="Count in">
          <button className={unit === 'usd' ? 'on' : ''} aria-pressed={unit === 'usd'} onClick={() => setUnit('usd')} title="Dollars, from the status line">
            USD
          </button>
          <button className={unit === 'tokens' ? 'on' : ''} aria-pressed={unit === 'tokens'} onClick={() => setUnit('tokens')} title="Tokens (input, output, cache), from the transcripts">
            Tokens
          </button>
          {hoursOk && (
            <button className={unit === 'hours' ? 'on' : ''} aria-pressed={unit === 'hours'} onClick={() => setUnit('hours')} title="Estimated working hours per account, day and ticket">
              Hours
            </button>
          )}
        </div>
        <div className="seg">
          {(['today', 'week', '30d', 'all'] as Range[]).map((r) => (
            <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
              {r === 'today' ? 'Today' : r === 'week' ? '7 days' : r === '30d' ? '30 days' : 'All time'}
            </button>
          ))}
        </div>
      </header>
      <div className="panel-body">
        {unit === 'hours' ? (
          <HoursView state={state} from={from} to={today} />
        ) : (
          <>
            <div className="kpis">
              {(
                [
                  ['Today', today],
                  ['Last 7 days', dayOf(now - 6 * 86_400_000)],
                  ['Last 30 days', dayOf(now - 29 * 86_400_000)],
                ] as [string, string][]
              ).map(([label, start]) => {
                const usd = formatCost(sumBetween(daily, start, today))
                const toks = tok(allTokens, start, today)
                return <Kpi key={label} label={label} value={inTokens ? toks : usd} sub={inTokens ? usd : `${toks} tokens`} />
              })}
              <Kpi label="Sessions without cost data" value={String(untracked)} hint="no status line file yet" />
            </div>
            <h3 className="sec">Last 14 days</h3>
            <div className="bars" role="img" aria-label={`${inTokens ? 'Tokens' : 'Spend'} per day, last 14 days`}>
              {days14.map((d) => {
                const v = dayValue(d)
                return (
                  <div key={d} className="bar-col" title={`${d}: ${formatCost(daily[d] ?? 0)}${tokens ? `\n${tokenTitle(tokensBetween(allTokens, d, d))}` : ''}`}>
                    <span className="bar-val">{v > 0 ? fmt(v) : ''}</span>
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
                      <th className="r">{inTokens ? 'Tokens' : 'In range'}</th>
                      <th className="r">{inTokens ? 'Spend' : 'Tokens'}</th>
                      <th className="r">All time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted">
                          {inTokens ? 'No ticket tokens in this range.' : 'No ticket spend in this range.'}
                        </td>
                      </tr>
                    )}
                    {(inTokens ? [...tickets].sort((a, b) => tokensIn(ticketTokens.get(b[0])) - tokensIn(ticketTokens.get(a[0]))) : tickets).map(([n, v]) => (
                      <tr key={n} className={cap > 0 && (allTime[n] ?? 0) > cap ? 'over' : ''}>
                        <td>
                          {labelOf(n)} <span className="muted">{titles.get(n) ?? ''}</span>
                        </td>
                        <td className="r">{inTokens ? rangeTok(ticketTokens.get(n)) : formatCost(v)}</td>
                        <td className="r muted">{inTokens ? formatCost(v) : rangeTok(ticketTokens.get(n))}</td>
                        <td className="r">
                          {inTokens ? tok(ticketTokens.get(n), '0000-00-00', '9999-99-99') : formatCost(allTime[n] ?? v)}
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
                      <th className="r">{inTokens ? 'Tokens' : 'Spend'}</th>
                      <th className="r">{inTokens ? 'Spend' : 'Tokens'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted">
                          {inTokens ? 'No tokens in this range.' : 'No spend in this range.'}
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
                          <td>{rec.issue !== null ? ticketLabel(rec.issueRepo, rec.issue) : '—'}</td>
                          {inTokens ? (
                            <>
                              <td className="r" title={tokens?.[id] ? tokenTitle(range === 'all' ? tokensBetween(tokens[id], '0000-00-00', '9999-99-99') : tokensBetween(tokens[id], from, today)) : undefined}>
                                {rangeTok(tokens?.[id])}
                              </td>
                              <td className="r muted">{formatCost(spend)}</td>
                            </>
                          ) : (
                            <>
                              <td className="r">{formatCost(spend)}</td>
                              <td className="r muted" title={tokens?.[id] ? tokenTitle(range === 'all' ? tokensBetween(tokens[id], '0000-00-00', '9999-99-99') : tokensBetween(tokens[id], from, today)) : undefined}>
                                {rangeTok(tokens?.[id])}
                              </td>
                            </>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
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
