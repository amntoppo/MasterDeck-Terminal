import { memo } from 'react'
import type { ColumnCount, DeliveryView } from '@shared/dashboard'
import { Card, Skeleton } from './Card'
import type { DashNav } from './nav'
import { Sparkline } from './Sparkline'

/** Board columns take these in order; "No status" is grey. Fixed, so a column keeps its colour. */
const COLUMN_TOKENS = ['faint', 'accent', 'purple', 'teal', 'orange', 'aqua', 'violet', 'green']
const colourOf = (c: ColumnCount, i: number) => (c.name === 'No status' ? 'var(--grey)' : `var(--${COLUMN_TOKENS[i % COLUMN_TOKENS.length]})`)

const KPI_TIP: Record<string, string> = {
  mine: 'Your open PRs, drafts included',
  review: 'Open PRs where your review is requested',
  merged: 'Your PRs merged in the last 7 days',
  ready: 'Your PRs that are approved, with checks green and no open threads',
}
const STAGE_TIP: Record<string, string> = {
  draft: 'Your open draft PRs',
  review: 'Your open PRs waiting for a review',
  changes: 'Your open PRs with changes requested',
  approved: 'Your open PRs that are approved',
}

function Columns({ columns, total }: { columns: ColumnCount[]; total: number }) {
  return (
    <>
      <div className="dash-bar" title={`${total} ticket${total === 1 ? '' : 's'}`}>
        {columns.map((c, i) =>
          c.count ? <span key={c.name} style={{ width: `${(c.count / Math.max(1, total)) * 100}%`, background: colourOf(c, i) }} /> : null,
        )}
      </div>
      <div className="dash-legend">
        {columns.map((c, i) => (
          <span key={c.name} title={`Tickets in ${c.name}`}>
            <span className="dash-dot" style={{ background: colourOf(c, i) }} /> {c.name} {c.count}
          </span>
        ))}
      </div>
    </>
  )
}

/** Delivery (#183): the sprint's columns and burndown, and where my PRs stand. */
export const DeliveryCard = memo(function DeliveryCard({
  view,
  loading,
  prsRead,
  nav,
  compact,
}: {
  view: DeliveryView
  loading: boolean
  /** The team's PRs were read at least once. */
  prsRead: boolean
  nav: DashNav
  compact?: boolean
}) {
  const sp = view.sprint
  const kpis = compact ? view.prs.kpis.filter((k) => k.id === 'mine' || k.id === 'review') : view.prs.kpis
  return (
    <Card
      id="delivery"
      title="Delivery"
      count={sp.kind === 'board' ? (sp.title ?? `${sp.total} tickets`) : 'No sprint'}
      countTip={sp.kind === 'board' ? (sp.title ? 'The sprint picked on the Board' : 'This board has no sprint field: every ticket on it') : sp.text}
      link="Board →"
      onLink={() => nav.view('board')}
      loading={loading}
    >
      {sp.kind === 'none' ? (
        <div className="dash-empty">{sp.text}</div>
      ) : sp.kind === 'derived' ? (
        <>
          <div className="dash-sub">{sp.text}</div>
          <Columns columns={sp.columns} total={sp.total} />
        </>
      ) : (
        <>
          <div className="dash-line">
            <strong>{sp.title ?? 'The board'}</strong>
            <span className="dash-sub" title="Tickets in the sprint">
              {sp.total} ticket{sp.total === 1 ? '' : 's'}
            </span>
          </div>
          <Columns columns={sp.columns} total={sp.total} />
          {sp.burndown && !compact && (
            <div>
              <div className="dash-sub dash-line">
                <span>Burndown · tickets left</span>
                <span className="dash-grow" />
                <span title="Tickets not done today, against where the ideal line is today">
                  {sp.burndown.left ?? '—'} left, {sp.burndown.planned} planned
                </span>
              </div>
              <Sparkline
                values={sp.burndown.points.map((p) => p.remaining)}
                ideal={sp.burndown.points.map((p) => p.ideal)}
                label={`Burndown: ${sp.burndown.points[0]?.ideal ?? 0} tickets at the start, ${sp.burndown.left ?? 'unknown'} left today, against a plan of ${sp.burndown.planned}`}
              />
            </div>
          )}
        </>
      )}

      <div className="dash-sec">Pull requests</div>
      {!prsRead ? (
        <Skeleton rows={2} />
      ) : (
        <>
          <div className="dash-kpis">
            {kpis.map((k) => (
              <button key={k.id} className="dash-kpi" title={`${KPI_TIP[k.id]}: ${k.value}`} onClick={() => nav.prsTab(k.tab)}>
                <span className={`dash-kv${k.value && k.id === 'review' ? ' dash-amber' : k.value && k.id === 'ready' ? ' dash-green' : ''}`}>{k.value}</span>
                <span className="dash-kl">{k.label.toLowerCase()}</span>
              </button>
            ))}
          </div>
          {!compact && (
            <div className="dash-legend">
              {view.prs.stages.map((s) => (
                <span key={s.id} title={`${STAGE_TIP[s.id]}: ${s.count}`} className={s.id === 'changes' && s.count ? 'dash-amber' : ''}>
                  {s.label} {s.count}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  )
})
