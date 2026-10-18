import { memo } from 'react'
import type { UsageView } from '@shared/dashboard'
import { formatCost } from '@shared/format'
import { formatTokens } from '@shared/tokens'
import { AccountBadge } from '../AccountBits'
import { Card } from './Card'
import type { DashNav } from './nav'
import { Sparkline } from './Sparkline'

const toks = (n: number | null) => (n === null ? '…' : formatTokens(n))

/** Usage and cost (#183): what sessions cost today and this week, per account, and what got in the way. */
export const UsageCard = memo(function UsageCard({ view, nav, compact }: { view: UsageView; nav: DashNav; compact?: boolean }) {
  const nothing = view.week.cost === 0 && view.today.cost === 0 && !view.warnings.length
  const top = Math.max(...view.trend.map((d) => d.cost))
  return (
    <Card
      id="usage"
      title="Usage and cost"
      count={`${formatCost(view.today.cost)} today`}
      countTip="What every session cost today, from the status line"
      link="Costs →"
      onLink={() => nav.view('costs')}
      empty={nothing ? 'No cost recorded this week.' : null}
    >
      <div className="dash-kpis dash-kpis-2">
        <div className="dash-kpi" title={`What every session cost today: ${formatCost(view.today.cost)}; ${view.today.tokens === null ? 'tokens still being counted' : `${view.today.tokens.toLocaleString()} tokens`}`}>
          <span className="dash-kv">{formatCost(view.today.cost)}</span>
          <span className="dash-kl">today · {toks(view.today.tokens)} tokens</span>
        </div>
        <div className="dash-kpi" title={`Monday to today: ${formatCost(view.week.cost)}; ${view.week.tokens === null ? 'tokens still being counted' : `${view.week.tokens.toLocaleString()} tokens`}`}>
          <span className="dash-kv">{formatCost(view.week.cost)}</span>
          <span className="dash-kl">this week · {toks(view.week.tokens)} tokens</span>
        </div>
      </div>
      {!compact && (
        <Sparkline
          values={view.trend.map((d) => d.cost)}
          label={`Cost per day over the last 7 days: ${view.trend.map((d) => `${d.date} ${formatCost(d.cost)}`).join(', ')}${top > 0 ? `; highest ${formatCost(top)}` : ''}`}
        />
      )}
      {view.accounts.length > 0 && (
        <div className="dash-utable" role="table" aria-label="Cost per account">
          <div className="dash-urow dash-uhead" role="row">
            <span role="columnheader">Account</span>
            <span role="columnheader" className="dash-num">Today</span>
            <span role="columnheader" className="dash-num">Week</span>
            <span role="columnheader" className="dash-num">Tokens</span>
          </div>
          {view.accounts.map((a) => (
            <div key={a.account ?? '-'} className="dash-urow" role="row">
              <span role="cell" className="dash-ell">
                {a.account ? <AccountBadge login={a.account} /> : <span className="dash-muted">{a.label}</span>}
              </span>
              <span role="cell" className="dash-num" title={`${a.label}, today`}>
                {formatCost(a.today)}
              </span>
              <span role="cell" className="dash-num" title={`${a.label}, Monday to today`}>
                {formatCost(a.week)}
              </span>
              <span role="cell" className="dash-num" title={`${a.label}: tokens this week`}>
                {toks(a.tokens)}
              </span>
            </div>
          ))}
        </div>
      )}
      {!compact && view.top.length > 0 && (
        <>
          <div className="dash-sec">Top sessions this week</div>
          <div className="dash-list">
            {view.top.map((t) => {
              const inner = (
                <>
                  <span className="dash-ell">{t.name}</span>
                  <span className="dash-r" title={`What ${t.name} cost this week`}>
                    {formatCost(t.cost)}
                  </span>
                </>
              )
              const key = t.key
              return key ? (
                <button key={t.sessionId} className="dash-mini dash-rowbtn" onClick={() => nav.session(key)}>
                  {inner}
                </button>
              ) : (
                <div key={t.sessionId} className="dash-mini">
                  {inner}
                </div>
              )
            })}
          </div>
        </>
      )}
      {!compact && view.warnings.map((w) => {
        const a = w.action
        return (
          <div key={w.id} className="dash-warn">
            <span className="dash-dot dash-d-warn" />
            <span>
              {w.text}
              {a && (
                <>
                  {' '}
                  <button className="dash-more" onClick={() => (a.type === 'session' ? nav.session(a.key) : nav.view('costs'))}>
                    {a.label}
                  </button>
                </>
              )}
            </span>
          </div>
        )
      })}
    </Card>
  )
})
