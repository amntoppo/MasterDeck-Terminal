import { memo, useState } from 'react'
import type { HealthAction, HealthRow, HealthStatus, HealthView } from '@shared/dashboard'
import { portLabel, portUrl } from '@shared/sessionProcs'
import { deck } from '../../deck'
import { Card } from './Card'
import type { DashNav } from './nav'

const DOT: Record<HealthStatus, string> = { ok: 'ok', warn: 'warn', bad: 'bad', unknown: 'wait' }
const STATUS_WORD: Record<HealthStatus, string> = { ok: 'Fine', warn: 'Worth a look', bad: 'Not working', unknown: 'Not known yet' }

/** Health (#183): one row per thing that can be wrong; "All good" when nothing is. */
export const HealthCard = memo(function HealthCard({
  view,
  nav,
  worktreesBusy,
  onCheckWorktrees,
  portLinks,
  compact,
}: {
  view: HealthView
  nav: DashNav
  worktreesBusy: boolean
  onCheckWorktrees: () => void
  portLinks: boolean
  compact?: boolean
}) {
  const [strays, setStrays] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const problems = view.rows.filter((r) => r.status === 'warn' || r.status === 'bad').length

  const act = (a: HealthAction) => {
    if (a.type === 'settings') nav.settings(a.section)
    else if (a.type === 'view') nav.view(a.view)
    else if (a.type === 'show-strays') setStrays((v) => !v)
    else if (a.type === 'check-worktrees') onCheckWorktrees()
    else if (a.type === 'update')
      void deck()
        .updateRestart()
        .then((r) => setMsg(r.ok ? null : (r.message ?? 'The update could not start.')))
  }

  const row = (r: HealthRow) => (
    <div key={r.id} className="dash-hrow-wrap">
      <div className="dash-hrow">
        <span className={`dash-dot dash-d-${DOT[r.status]}`} title={STATUS_WORD[r.status]} />
        <span>{r.label}</span>
        <span className="dash-hdt" title={r.detail}>{r.detail}</span>
        {r.action && (
          <button
            className={`btn${r.action.type === 'update' ? ' primary' : ''}${r.action.type === 'show-strays' && strays ? ' on' : ''}`}
            disabled={r.action.type === 'check-worktrees' && worktreesBusy}
            aria-expanded={r.action.type === 'show-strays' ? strays : undefined}
            onClick={() => act(r.action!)}
          >
            {r.action.type === 'check-worktrees' && worktreesBusy ? 'Checking…' : r.action.type === 'show-strays' && strays ? 'Hide' : r.action.label}
          </button>
        )}
      </div>
      {r.id === 'strays' && strays && r.strays && (
        <div className="dash-strays">
          {r.strays.map((s) => (
            <div key={s.pid} className="dash-mini">
              <span className="dash-mono dash-ell" title={`${s.command} (pid ${s.pid})`}>
                {s.command}
              </span>
              {s.ports.map((l) =>
                portLinks ? (
                  <button key={`${l.host}:${l.port}`} className="dash-link dash-mono" title={`Open ${portUrl(l)} in the browser`} onClick={() => deck().openPort(portUrl(l))}>
                    {portLabel(l)}
                  </button>
                ) : (
                  <span key={`${l.host}:${l.port}`} className="dash-mono">
                    {portLabel(l)}
                  </span>
                ),
              )}
              <span className="dash-r dash-ell" title={s.cwd ?? undefined}>
                {s.folderOf ?? s.cwd ?? ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <Card
      id="health"
      title="Health"
      count={view.summary}
      countTip={problems ? `${problems} thing${problems === 1 ? ' is' : 's are'} not quite right` : view.allGood ? 'Every check is fine' : 'Nothing is wrong; some things are not checked yet'}
      link="Settings →"
      onLink={() => nav.view('settings')}
    >
      {msg && <div className="dash-err">{msg}</div>}
      {view.allGood ? (
        <>
          <div className="dash-allgood">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12l5 5 9-10" />
            </svg>
            All good
          </div>
          {!compact && (
            <details className="dash-details">
              <summary>Details</summary>
              {view.rows.map(row)}
            </details>
          )}
        </>
      ) : compact ? (
        problems ? (
          view.rows.filter((r) => r.status === 'warn' || r.status === 'bad').map(row)
        ) : (
          <div className="dash-empty">Nothing is wrong. Some things are not checked yet.</div>
        )
      ) : (
        view.rows.map(row)
      )}
    </Card>
  )
})
