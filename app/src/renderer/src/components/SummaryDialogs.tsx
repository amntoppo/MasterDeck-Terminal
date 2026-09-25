import { useEffect, useMemo, useState } from 'react'
import { cardBadge } from '@shared/board'
import { burndown, summarize, summaryMarkdown } from '@shared/sprintSummary'
import { pointsText, rangeFor, standupPoints, type StandupCommit, type StandupRange } from '@shared/standup'
import type { AppState } from '@shared/types'
import { deck, load, save } from '../deck'

function useEsc(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

function Copy({ text, label = 'Copy as Markdown' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn primary"
      onClick={() => {
        deck().copy(text)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  )
}

export function SprintSummaryDialog({ state, onClose }: { state: AppState; onClose: () => void }) {
  useEsc(onClose)
  const b = state.board
  const s = useMemo(() => (b ? summarize(b, (n) => cardBadge(n, state.sessions, state.proposals).kind) : null), [b, state.sessions, state.proposals])
  const sprint = state.sprints.find((x) => x.title === b?.sprint)
  const series = sprint ? burndown(state.boardHistory[sprint.title] ?? [], sprint.startDate, sprint.duration) : []
  const max = Math.max(1, ...series.map((p) => Math.max(p.ideal, p.remaining ?? 0)))
  const md = b && s ? summaryMarkdown(b.sprint ?? 'Sprint', s) : ''
  const w = 560
  const h = 160
  const x = (i: number) => (series.length <= 1 ? 0 : (i / (series.length - 1)) * w)
  const y = (v: number) => h - (v / max) * h
  const real = series.map((p, i) => (p.remaining === null ? null : `${x(i)},${y(p.remaining)}`)).filter(Boolean)
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="Sprint summary">
        <h3>{b?.sprint ?? 'Sprint'} summary</h3>
        {!b || !s ? (
          <p className="meta">Open the board once to load the sprint.</p>
        ) : (
          <>
            <div className="kpis">
              <div className="kpi">
                <div className="kpi-v ok">{s.counts.done}</div>
                <div className="kpi-l">Done</div>
              </div>
              <div className="kpi">
                <div className="kpi-v">{s.counts.progress}</div>
                <div className="kpi-l">In progress</div>
              </div>
              <div className="kpi">
                <div className="kpi-v bad">{s.counts.blocked}</div>
                <div className="kpi-l">Blocked</div>
              </div>
              <div className="kpi">
                <div className="kpi-v">{s.counts.todo}</div>
                <div className="kpi-l">To do</div>
              </div>
              <div className="kpi">
                <div className="kpi-v">{s.total ? Math.round((s.counts.done / s.total) * 100) : 0}%</div>
                <div className="kpi-l">of {s.total} done</div>
              </div>
            </div>
            <h3 className="sec">Burndown</h3>
            {series.length === 0 ? (
              <p className="meta">The sprint dates load with the hourly refresh.</p>
            ) : (
              <svg className="burndown" viewBox={`-8 -8 ${w + 16} ${h + 28}`} role="img" aria-label="Burndown: remaining issues per day against the ideal line">
                <line x1={0} y1={h} x2={w} y2={h} className="axis" />
                <polyline points={series.map((p, i) => `${x(i)},${y(p.ideal)}`).join(' ')} className="ideal" />
                {real.length > 0 && <polyline points={real.join(' ')} className="real" />}
                {series.map((p, i) =>
                  p.remaining === null ? null : <circle key={p.date} cx={x(i)} cy={y(p.remaining)} r={3} className="real-dot"><title>{`${p.date}: ${p.remaining} remaining`}</title></circle>,
                )}
                <text x={0} y={h + 18} className="lbl">{series[0]?.date.slice(5)}</text>
                <text x={w} y={h + 18} className="lbl" textAnchor="end">{series.at(-1)?.date.slice(5)}</text>
              </svg>
            )}
            <p className="meta">Recorded at each board refresh (one point per day); dashed line = ideal.</p>
            <h3 className="sec">By person</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Who</th>
                  <th className="r">Done</th>
                  <th className="r">In progress</th>
                  <th className="r">Blocked</th>
                  <th className="r">To do</th>
                </tr>
              </thead>
              <tbody>
                {s.byAssignee.map((r) => (
                  <tr key={r.login}>
                    <td>{r.login === state.me ? `${r.login} (me)` : r.login}</td>
                    <td className="r">{r.done}</td>
                    <td className="r">{r.progress}</td>
                    <td className="r">{r.blocked || ''}</td>
                    <td className="r">{r.todo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <pre className="pr-body md">{md}</pre>
          </>
        )}
        <div className="foot">
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {md && <Copy text={md} />}
        </div>
      </div>
    </div>
  )
}

const RANGES: [StandupRange, string][] = [
  ['last-standup', 'Since last standup'],
  ['yesterday', 'Yesterday'],
  ['3d', 'Last 3 days'],
  ['week', 'This week'],
  ['custom', 'Custom…'],
]

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

export function StandupDialog({ state, onClose }: { state: AppState; onClose: () => void }) {
  useEsc(onClose)
  const [range, setRange] = useState<StandupRange>(() => load<StandupRange>('standupRange', 'last-standup'))
  const [custom, setCustom] = useState(() => {
    const r = rangeFor('last-standup', new Date())
    return { from: ymd(r.since), to: ymd(new Date()) }
  })
  const [commits, setCommits] = useState<StandupCommit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => save('standupRange', range), [range])

  // [since, until): a preset, or the custom days (the "to" day included).
  const { since, until } = useMemo(() => {
    if (range !== 'custom') return rangeFor(range, new Date())
    const from = new Date(`${custom.from}T00:00:00`)
    const to = new Date(`${custom.to}T00:00:00`)
    return { since: from, until: new Date(to.getTime() + 86_400_000) }
  }, [range, custom])
  const valid = Number.isFinite(since.getTime()) && Number.isFinite(until.getTime()) && since < until

  // The folders sessions work in, taken once when the dialog opens (the state updates every few
  // seconds and would restart the scan).
  const dirs = useMemo(() => {
    const d = new Set<string>()
    for (const s of state.sessions) {
      if (s.cwd) d.add(s.cwd)
      const cur = state.stats[s.sessionId]?.currentDir
      if (cur) d.add(cur)
    }
    for (const g of Object.values(state.git)) d.add(g.dir)
    return [...d]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Changing the range reads git again; a slower answer for an older range is dropped.
  useEffect(() => {
    if (!valid) return
    let alive = true
    setCommits(null)
    setError(null)
    deck()
      .standupCommits(since.getTime(), dirs, until.getTime())
      .then((c) => alive && setCommits(c))
      .catch((e: unknown) => {
        if (!alive) return
        setError(String(e))
        setCommits([])
      })
    return () => {
      alive = false
    }
  }, [since, until, valid, dirs])

  const titles: Record<number, string> = {}
  for (const i of state.issues) titles[i.number] = i.title
  for (const c of state.board?.cards ?? []) titles[c.number] ??= c.title
  const sinceIso = since.toISOString()
  const untilIso = until.toISOString()
  const inRange = (t: string | null | undefined) => !!t && t >= sinceIso && t < untilIso
  const prs = state.prs
    .filter((p) => p.authorIsMe && inRange(p.updatedAt))
    .map((p) => ({ url: p.url, repo: p.repo, number: p.number, title: p.title, issue: p.refsIssue }))
  const reports = state.proposals
    .filter((p) => p.kind !== 'CHAT' && ['done', 'blocked', 'question'].includes(p.status) && p.note)
    // Open questions/blocks still count (no close time); finished work counts when it finished in range.
    .filter((p) => (p.closedAt ? inRange(p.closedAt) : p.status !== 'done'))
    .map((p) => ({ issue: p.issue, status: p.status, note: p.note ?? '' }))
  // Commits on a session's branch belong to that session's ticket even when the branch has no number.
  const byBranch = new Map<string, number>()
  for (const s of state.sessions) {
    const br = state.git[s.sessionId]?.branch ?? state.tails[s.sessionId]?.gitBranch
    if (br && s.issue !== null) byBranch.set(br, s.issue)
  }
  const cs = (commits ?? []).map((c) => ({ ...c, issue: c.issue ?? (c.branch ? (byBranch.get(c.branch) ?? null) : null) }))
  const tickets = commits ? standupPoints(titles, cs, prs, reports) : []
  const lastDay = new Date(until.getTime() - 1)
  const label = ymd(since) === ymd(lastDay) ? fmtDay(since) : `${fmtDay(since)} – ${fmtDay(lastDay)}`
  const text = pointsText(label, tickets)

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="Standup">
        <h3>Standup</h3>
        <div className="standup-range">
          <div className="seg">
            {RANGES.map(([r, name]) => (
              <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
                {name}
              </button>
            ))}
          </div>
          {range === 'custom' && (
            <span className="custom-range">
              <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
              <span className="muted">to</span>
              <input type="date" value={custom.to} min={custom.from} max={ymd(new Date())} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </span>
          )}
        </div>
        <div className="meta">
          {error && <span className="error">Git history failed: {error}. </span>}
          {!valid
            ? 'Pick a start date before the end date.'
            : commits
              ? `${label}: ${tickets.filter((t) => t.issue !== null).length} tickets · ${cs.length} commits · ${prs.length} PRs · ${reports.length} session reports`
              : `${label}: reading git history…`}
        </div>
        <div className="standup-list">
          {!commits && valid && <div className="empty">Loading…</div>}
          {commits && tickets.length === 0 && <div className="empty">Nothing recorded in this range.</div>}
          {tickets.map((t) => (
            <div key={String(t.issue)} className="standup-ticket">
              <div className="standup-title">
                {t.issue !== null && <span className="num">#{t.issue}</span>} {t.title}
              </div>
              <ul>
                {t.points.map((p, i) => {
                  const [head, ...rest] = p.split(': ')
                  return (
                    <li key={i}>
                      {rest.length ? (
                        <>
                          <b className={`pt pt-${head.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{head}:</b> {rest.join(': ')}
                        </>
                      ) : (
                        p
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="foot">
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {commits && tickets.length > 0 && <Copy text={text} label="Copy points" />}
        </div>
      </div>
    </div>
  )
}
