import { memo } from 'react'
import { type NowChip, type NowView } from '@shared/dashboard'
import { AccountBadge } from '../AccountBits'
import { deck } from '../../deck'
import { ago, Card } from './Card'
import { go, type DashNav } from './nav'

const DOT: Record<NowChip, string> = { working: 'work', background: 'busy', waiting: 'wait', 'needs-you': 'bad' }

/** "18 min", "3 h 46 min", "2 d". */
export function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  return `${Math.floor(h / 24)} d`
}

/** Now (#183): sessions at work, their ports, what is watched, and the next scheduled runs. */
export const NowCard = memo(function NowCard({
  view,
  now,
  loading,
  nav,
  procsBusy,
  onRefresh,
  portLinks,
  windows,
  compact,
}: {
  view: NowView
  now: number
  loading: boolean
  nav: DashNav
  procsBusy: boolean
  onRefresh: () => void
  /** Ports open in the browser (the window); on the web they are text. */
  portLinks: boolean
  /** Processes are not read on Windows. */
  windows: boolean
  /** The phone (#183 Task 12). */
  compact?: boolean
}) {
  const working = view.sessions.filter((s) => s.chip === 'working').length
  const ports = view.procs?.rows.reduce((n, r) => n + r.ports.length, 0) ?? 0
  return (
    <Card
      id="now"
      title="Now"
      count={`${view.total} running`}
      countTip={`${view.total} session${view.total === 1 ? ' is' : 's are'} working, running a background command, waiting or asking for you (${working} working)${view.procs ? `; ${ports} port${ports === 1 ? '' : 's'} open` : ''}`}
      link="Terminals →"
      onLink={() => nav.view('terminals')}
      loading={loading}
    >
      {view.sessions.length === 0 ? (
        <div className="dash-empty">No session is working. Start one from the Board or with New.</div>
      ) : (
        <div className="dash-list">
          {view.sessions.map((s) => (
            <button key={s.key} className="dash-srow" onClick={() => nav.session(s.key)}>
              <span className="dash-sname">
                <span className="dash-ell">{s.name}</span>
                {s.account && <AccountBadge login={s.account} />}
              </span>
              <span className="dash-chip">
                <span className={`dash-dot dash-d-${DOT[s.chip]}`} />
                {s.chipLabel} · <span title={`Started ${new Date(s.since).toLocaleString()}`}>{duration(now - s.since)}</span>
              </span>
              {s.ticket && <span className="dash-sline">{s.ticket}</span>}
              {s.lastTool && !compact && (
                <span className="dash-sline dash-mono">
                  {s.lastTool}
                  {s.lastToolAt ? ` · ${ago(s.lastToolAt, now)}` : ''}
                </span>
              )}
            </button>
          ))}
          {view.more > 0 && (
            <button className="dash-more" onClick={() => nav.view('terminals')} title={`${view.more} more session${view.more === 1 ? '' : 's'} at work`}>
              {view.more} more →
            </button>
          )}
        </div>
      )}

      {compact && (
        <div className="dash-mini dash-muted dash-nowsum">
          {[
            view.procs && !windows ? `${ports} port${ports === 1 ? '' : 's'} open` : null,
            view.watching.length ? `${view.watching.length} watched` : null,
            view.nextRuns[0] ? `next: ${view.nextRuns[0].name} ${view.nextRuns[0].when}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'Nothing watched or scheduled'}
        </div>
      )}
      {!compact && (
        <>
          <div className="dash-sec">Processes and ports</div>
          {windows ? (
            <div className="dash-mini dash-muted">Not available on Windows</div>
          ) : (
            <div className="dash-list">
              {view.procs?.error && <div className="dash-mini dash-warn-text">{view.procs.error}</div>}
              {view.procs?.rows.map((r) => (
                <div key={`${r.key}:${r.pid}`} className="dash-mini">
                  <span className="dash-mono dash-ell" title={r.command}>
                    {r.command}
                  </span>
                  {r.ports.map((p) =>
                    portLinks ? (
                      <button key={p} className="dash-link dash-mono" title={`Open localhost:${p} in the browser`} onClick={() => deck().openPort(`http://localhost:${p}`)}>
                        :{p}
                      </button>
                    ) : (
                      <span key={p} className="dash-mono" title={`Port ${p}`}>
                        :{p}
                      </span>
                    ),
                  )}
                  <button className="dash-r dash-link-quiet" onClick={() => nav.session(r.key)}>
                    {r.session}
                  </button>
                </div>
              ))}
              {view.procs && !view.procs.rows.length && !view.procs.error && <div className="dash-mini dash-muted">No session has a port open.</div>}
              <div className="dash-mini dash-muted">
                <span>{procsBusy ? 'Reading…' : view.procs ? `Read ${ago(view.procs.at, now)}` : 'Not read yet'}</span>
                <button className="dash-more dash-r" disabled={procsBusy} onClick={onRefresh}>
                  Refresh
                </button>
              </div>
            </div>
          )}

          {view.watching.length > 0 && (
            <>
              <div className="dash-sec">Watching</div>
              <div className="dash-list">
                {view.watching.map((w) => (
                  <button key={w.id} className="dash-mini dash-rowbtn" onClick={() => go(nav, w.target)}>
                    <span className="dash-dot dash-d-ok" />
                    <span className="dash-ell">{w.label}</span>
                    <span className="dash-r">{w.at ? `event ${ago(w.at, now)}` : 'no event yet'}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {view.nextRuns.length > 0 && (
            <>
              <div className="dash-sec">Next runs</div>
              <div className="dash-list">
                {view.nextRuns.map((r) => (
                  <button key={r.id} className="dash-mini dash-rowbtn" onClick={() => nav.view('schedules')}>
                    <span className="dash-ell">{r.name}</span>
                    <span className="dash-r" title={new Date(r.at).toLocaleString()}>
                      {r.when}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Card>
  )
})
