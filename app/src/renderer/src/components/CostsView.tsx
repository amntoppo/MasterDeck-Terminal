import { useEffect, useMemo, useRef, useState } from 'react'
import { parseTicket, ticketKey, ticketLabel } from '@shared/ticket'
import { bucketSpend, sessionSpendIn, spendIn, ticketSpend } from '@shared/costs'
import { formatCost } from '@shared/format'
import { bucketSpan, chartBars, customRange, customValues, midnight, parseRange, PRESET_LABEL, PRESETS, rangeLabel, resolveRange, toInputValue, type Preset, type RangeChoice } from '@shared/timeline'
import { formatTokens, mergeByDay, NO_TOKENS, tokenSum, tokensIn, tokenTitle, type Tokens, type TokensByDay } from '@shared/tokens'
import { deck, load, save } from '../deck'
import { can } from '../web'
import { HoursView } from './HoursView'
import type { AppState, Session } from '@shared/types'

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
}

/** What the screen counts: dollars (the status line), tokens or working hours (the transcripts). */
type Unit = 'usd' | 'tokens' | 'hours'

export function CostsView({ state, onOpenSession }: Props) {
  // The time filter (#88), kept across restarts like the unit.
  const [choice, setChoiceState] = useState<RangeChoice>(() => parseRange(load<unknown>('costsRange', null)))
  const setChoice = (c: RangeChoice) => {
    setChoiceState(c)
    save('costsRange', c)
  }
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
  // Tokens per session and hour, from the transcripts; the first load reads their history once.
  const [tokens, setTokens] = useState<Record<string, TokensByDay> | null>(null)
  // To the minute: the state ticks every few seconds, the sums need not.
  const now = Math.floor(Date.now() / 60_000) * 60_000
  const { from, to } = resolveRange(choice, now)
  const label = rangeLabel(choice, now)
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
  const spend = useMemo(() => bucketSpend(book), [book])
  // '…' while counting; '—' for a session whose transcript is gone.
  const tokText = (byDay: TokensByDay | undefined, t: Tokens | null) => (!tokens ? '…' : !byDay ? '—' : formatTokens(tokenSum(t ?? NO_TOKENS)))
  const fmt = (v: number) => (inTokens ? formatTokens(v) : formatCost(v))

  const totalUsd = spendIn(spend, from, to, now)
  const totalTok = useMemo(() => tokensIn(allTokens, from, to, now), [allTokens, from, to, now])
  const sessions = useMemo(
    () =>
      Object.entries(book)
        .map(([id, rec]) => {
          const t = tokens?.[id] ? tokensIn(tokens[id], from, to, now) : null
          return { id, rec, spend: sessionSpendIn(rec, from, to, now), t, toks: t ? tokenSum(t) : 0 }
        })
        .filter((x) => (inTokens ? x.toks > 0 : x.spend > 0.005))
        .sort((a, b) => (inTokens ? b.toks - a.toks : b.spend - a.spend)),
    [book, from, to, now, tokens, inTokens],
  )
  const ticketTokens = useMemo(() => {
    const out = new Map<string, TokensByDay>()
    for (const [id, rec] of Object.entries(book)) {
      if (rec.issue === null || !tokens?.[id]) continue
      const k = ticketKey(rec.issueRepo, rec.issue)
      out.set(k, mergeByDay([out.get(k) ?? {}, tokens[id]]))
    }
    return out
  }, [book, tokens])
  const tickets = useMemo(() => {
    // By ticketKey: two repos can each have a #12.
    const out = new Map<string, number>()
    for (const x of sessions) {
      if (x.rec.issue === null) continue
      const k = ticketKey(x.rec.issueRepo, x.rec.issue)
      out.set(k, (out.get(k) ?? 0) + x.spend)
    }
    const rows = [...out].map(([k, v]) => {
      const byDay = ticketTokens.get(k)
      const t = byDay ? tokensIn(byDay, from, to, now) : null
      return { k, spend: v, byDay, t, toks: t ? tokenSum(t) : 0, all: byDay ? tokensIn(byDay, 0, Number.MAX_SAFE_INTEGER, now) : null }
    })
    return rows.sort((a, b) => (inTokens ? b.toks - a.toks : b.spend - a.spend))
  }, [sessions, ticketTokens, from, to, now, inTokens])
  const allTime = ticketSpend(book)

  // The chart: the whole range; All time from the first recorded bucket.
  const first = useMemo(() => {
    let min = Infinity
    for (const [b, v] of Object.entries(spend)) if (v > 0) min = Math.min(min, bucketSpan(b)?.[0] ?? Infinity)
    for (const [b, v] of Object.entries(allTokens)) if (tokenSum(v) > 0) min = Math.min(min, bucketSpan(b)?.[0] ?? Infinity)
    return min
  }, [spend, allTokens])
  const chart = useMemo(() => {
    const a = choice.preset === 'all' ? Math.max(from, first) : from
    if (!(a < to)) return null
    const { unit: per, bars } = chartBars(a, to, now)
    return {
      per,
      bars: bars.map((b) => {
        const [s, e] = [Math.max(b.start, from), Math.min(b.end, to)]
        const usd = spendIn(spend, s, e, now)
        const t = tokensIn(allTokens, s, e, now)
        return { ...b, usd, t, v: inTokens ? tokenSum(t) : usd }
      }),
    }
  }, [choice.preset, from, to, now, first, spend, allTokens, inTokens])
  const maxBar = Math.max(inTokens ? 1 : 0.01, ...(chart?.bars.map((b) => b.v) ?? []))
  const labelEvery = chart && chart.bars.length > 24 ? Math.ceil(chart.bars.length / 24) : 1
  // Nothing spent and nothing used: once the transcripts are counted, so "…" never reads as empty.
  const empty = totalUsd < 0.005 && tokens !== null && tokenSum(totalTok) === 0

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

  const per = chart ? (chart.per === 'hour' ? 'per hour' : chart.per === 'day' ? 'per day' : chart.per === 'week' ? 'per week' : 'per month') : ''

  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>Costs</h2>
        <span className="muted">
          {unit === 'hours' ? (
            'estimated working hours per GitHub account, from session activity on this Mac'
          ) : (
            <>
              from the status line hook, tokens from the transcripts{tokens ? '' : ' (counting…)'} · {Object.keys(book).length} sessions recorded · spend a session had before MasterDeck first saw it counts in All time and per ticket, not in a period
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
        <RangePicker choice={choice} now={now} onChange={setChoice} />
      </header>
      <div className="panel-body">
        {unit === 'hours' ? (
          <HoursView state={state} from={from} to={to} />
        ) : empty ? (
          <div className="costs-empty">
            <strong>No costs in this period</strong>
            <span className="muted">{label}: nothing was spent and no tokens were used. Pick a longer range above.</span>
          </div>
        ) : (
          <>
            <div className="kpis">
              <Kpi
                label={label}
                value={inTokens ? tokText(allTokens, totalTok) : formatCost(totalUsd)}
                sub={inTokens ? formatCost(totalUsd) : `${tokText(allTokens, totalTok)} tokens`}
                hint={tokens ? tokenTitle(totalTok) : undefined}
              />
              <Kpi label="Sessions" value={String(sessions.length)} hint={`Sessions with ${inTokens ? 'tokens' : 'spend'} in this range`} />
              <Kpi label="Tickets" value={String(tickets.length)} hint={`Tickets with ${inTokens ? 'tokens' : 'spend'} in this range`} />
              <Kpi label="Sessions without cost data" value={String(untracked)} hint="no status line file yet" />
            </div>
            {chart && (
              <>
                <h3 className="sec">
                  {inTokens ? 'Tokens' : 'Spend'} {per}
                </h3>
                <div className={`bars${chart.bars.length > 31 ? ' dense' : ''}`} role="img" aria-label={`${inTokens ? 'Tokens' : 'Spend'} ${per}, ${label}`}>
                  {chart.bars.map((b, i) => (
                    <div key={b.start} className="bar-col" title={`${b.title}: ${formatCost(b.usd)}${tokens ? `\n${tokenTitle(b.t)}` : ''}`}>
                      <span className="bar-val">{b.v > 0 && chart.bars.length <= 16 ? fmt(b.v) : ''}</span>
                      <span className={`bar-fill ${b.current ? 'today' : ''}`} style={{ height: `${Math.max(2, (b.v / maxBar) * 100)}%` }} />
                      <span className="bar-day">{i % labelEvery === 0 ? b.label : ''}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
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
                    {tickets.map(({ k, spend: v, byDay, t, all }) => (
                      <tr key={k} className={cap > 0 && (allTime[k] ?? 0) > cap ? 'over' : ''}>
                        <td>
                          {labelOf(k)} <span className="muted">{titles.get(k) ?? ''}</span>
                        </td>
                        <td className="r">{inTokens ? tokText(byDay, t) : formatCost(v)}</td>
                        <td className="r muted">{inTokens ? formatCost(v) : tokText(byDay, t)}</td>
                        <td className="r">
                          {inTokens ? tokText(byDay, all) : formatCost(allTime[k] ?? v)}
                          {cap > 0 && (allTime[k] ?? 0) > cap ? ' ⚠' : ''}
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
                    {sessions.map(({ id, rec, spend: v, t }) => {
                      const live = state.sessions.find((s) => s.sessionId === id || s.key === rec.key)
                      const tokCell = (
                        <td className={inTokens ? 'r' : 'r muted'} title={t ? tokenTitle(t) : undefined}>
                          {tokText(tokens?.[id], t)}
                        </td>
                      )
                      return (
                        <tr key={id} className={live ? 'link' : ''} onClick={() => live && onOpenSession(live)} title={live ? 'Open' : id}>
                          <td>
                            {live && <span className={`dot ${live.state}`} />} {rec.name}
                          </td>
                          <td>{rec.issue !== null ? ticketLabel(rec.issueRepo, rec.issue) : '—'}</td>
                          {inTokens ? (
                            <>
                              {tokCell}
                              <td className="r muted">{formatCost(v)}</td>
                            </>
                          ) : (
                            <>
                              <td className="r">{formatCost(v)}</td>
                              {tokCell}
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

/**
 * The time filter: a preset, or a custom range picked in a small form under it. A custom range
 * shows its dates in the list ("3 Oct – 9 Oct"), so the range reads at a glance either way.
 */
function RangePicker({ choice, now, onChange }: { choice: RangeChoice; now: number; onChange: (c: RangeChoice) => void }) {
  const [editing, setEditing] = useState(false)
  const [vals, setVals] = useState({ from: '', to: '' })
  const box = useRef<HTMLDivElement>(null)
  const open = () => {
    // The current custom range, else the last 7 days up to now.
    setVals(choice.preset === 'custom' ? customValues(choice) : { from: toInputValue(midnight(now, -6)), to: toInputValue(now) })
    setEditing(true)
  }
  useEffect(() => {
    if (!editing) return
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setEditing(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [editing])
  const res = customRange(vals.from, vals.to)
  const apply = () => {
    if (!('range' in res)) return
    onChange(res.range)
    setEditing(false)
  }
  const label = rangeLabel(choice, now)
  return (
    <div className="range-pick" ref={box}>
      <select
        aria-label="Time range"
        value={editing ? 'custom' : choice.preset}
        title={label}
        onChange={(e) => {
          const p = e.target.value as Preset
          if (p === 'custom') open()
          else {
            setEditing(false)
            onChange({ preset: p })
          }
        }}
      >
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {p === 'custom' && choice.preset === 'custom' ? label : PRESET_LABEL[p]}
          </option>
        ))}
      </select>
      {choice.preset === 'custom' && !editing && (
        <button className="btn" onClick={open} title="Change the dates" aria-label="Change the dates">
          ✎
        </button>
      )}
      {editing && (
        <div
          className="range-form"
          role="dialog"
          aria-label="Custom range"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'Enter') apply()
          }}
        >
          <label>
            From
            <input type="datetime-local" value={vals.from} onChange={(e) => setVals({ ...vals, from: e.target.value })} autoFocus />
          </label>
          <label>
            To
            <input type="datetime-local" value={vals.to} min={vals.from || undefined} onChange={(e) => setVals({ ...vals, to: e.target.value })} />
          </label>
          {'error' in res && (
            <div className="range-err" role="alert">
              {res.error}
            </div>
          )}
          <div className="range-actions">
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!('range' in res)} onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
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
