import { issueUrl } from '@shared/appConfig'
import { useMemo, useState } from 'react'
import { ticketSpend } from '@shared/costs'
import { idleNudges, type Nudge } from '@shared/nudge'
import { MASTER_NAME, sessionForIssue, sessionForProposal, sortSessions } from '@shared/derive'
import { formatAgo, formatCost, formatGhCache, formatRefreshed } from '@shared/format'
import type { AppState, Issue, NeedsItem, Proposal, Session } from '@shared/types'
import { deck, KIND_COLOR, useNow } from '../deck'
import type { PaletteAction } from './CommandPalette'
import { OfferRow, useDismissed } from './PrsView'
import { prOffers } from '@shared/offers'

export type View = 'terminals' | 'board' | 'prs' | 'costs' | 'janitor' | 'history'

interface Props {
  state: AppState
  activeKey: string | null
  onOpenSession: (s: Session) => void
  onIssue: (issue: Issue) => void
  onNewShell: () => void
  needsYouRef: React.RefObject<HTMLDivElement | null>
  view: View
  onView: (v: View) => void
  /** Footer tools and the palette's actions. */
  onTool: (a: PaletteAction) => void
  onStartWith: (issue: Issue, instructions: string) => void
}

const STATE_LABEL: Record<string, string> = {
  working: 'working',
  idle: 'idle',
  'needs-input': 'needs input',
  suspended: 'suspended',
  done: 'done',
}

export function Sidebar({ state, activeKey, onOpenSession, onIssue, onNewShell, needsYouRef, view, onView, onTool, onStartWith }: Props) {
  const now = useNow()
  const [showSuspended, setShowSuspended] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const sessions = useMemo(
    () => sortSessions(state.sessions.filter((s) => s.name !== MASTER_NAME && s.state !== 'done')),
    [state.sessions],
  )
  const live = sessions.filter((s) => s.state !== 'suspended')
  const suspended = sessions.filter((s) => s.state === 'suspended')

  const refresh = async () => {
    setRefreshing(true)
    await deck().refresh()
    setRefreshing(false)
  }

  const extras = useExtras(state, now)
  const [dismissed, dismiss] = useDismissed()
  const extraShown = extras.filter((x) => !dismissed.has(extraKey(x, state)))
  const needsShown = state.needsYou.filter((n) => !dismissed.has(needsDismissKey(n, state)))
  const offers = useMemo(() => prOffers(state.prs.filter((p) => p.authorIsMe), state.sessions, state.sessionPrs, state.proposals, dismissed), [state.prs, state.sessions, state.sessionPrs, state.proposals, dismissed])
  const prAttention = offers.length + state.prs.filter((p) => p.reviewRequested).length
  const hot = needsShown.filter((n) => n.kind !== 'attention' || n.proposal.status !== 'held').length

  return (
    <aside className="sidebar">
      <div className="drag-top">MasterDeck</div>
      <div className="view-switch" role="tablist">
        {(
          [
            ['terminals', 'Terminals'],
            ['board', 'Board View'],
            ['prs', 'PRs'],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => onView(v)}>
            {label}
            {v === 'prs' && prAttention > 0 && <span className="count hot mini">{prAttention}</span>}
          </button>
        ))}
      </div>
      <div className="scroll">
        <div className="section" ref={needsYouRef}>
          <div className="section-head">
            Needs you <span className={`count ${hot || extraShown.length ? 'hot' : ''}`}>{needsShown.length + extraShown.length + offers.length}</span>
          </div>
          {needsShown.length === 0 && extraShown.length === 0 && offers.length === 0 && <div className="empty">Nothing waiting on you.</div>}
          {extraShown.map((x) => (
            <ExtraCard key={x.id} x={x} state={state} onOpenSession={onOpenSession} onClose={() => dismiss(extraKey(x, state))} />
          ))}
          {offers.map((o) => (
            <div key={o.id} className="card" style={{ ['--kind' as string]: o.kind === 'ci' ? 'var(--red)' : 'var(--accent)' }}>
              <CloseX onClose={() => dismiss(o.id)} />
              <OfferRow o={o} state={state} onDismiss={() => dismiss(o.id)} onStartWith={onStartWith} onOpenSession={onOpenSession} />
            </div>
          ))}
          {needsShown.map((item) => (
            <NeedsCard key={needsKey(item)} item={item} state={state} onOpenSession={onOpenSession} onIssue={onIssue} onClose={() => dismiss(needsDismissKey(item, state))} />
          ))}
        </div>

        <div className="section">
          <div className="section-head">
            Sessions <span className="count">{live.length}</span>
            <span className="spacer" />
            <button onClick={onNewShell} title="Open a plain shell tab">
              + Shell
            </button>
          </div>
          {live.length === 0 && <div className="empty">No live sessions.</div>}
          {live.map((s) => (
            <SessionRow key={s.key} s={s} active={s.key === activeKey} now={now} onClick={() => onOpenSession(s)} />
          ))}
          {suspended.length > 0 && (
            <div className="row" onClick={() => setShowSuspended(!showSuspended)}>
              <span className="mark">{showSuspended ? '▾' : '▸'}</span>
              <span className="label sub">{suspended.length} suspended</span>
            </div>
          )}
          {showSuspended &&
            suspended.map((s) => (
              <SessionRow key={s.key} s={s} active={s.key === activeKey} now={now} onClick={() => onOpenSession(s)} />
            ))}
        </div>

      </div>
      <div className="sidebar-footer">
        <div className="tools">
          {(
            [
              ['palette', '⌘K', 'Command palette (⌘K)'],
              ['broadcast', '📣', 'Broadcast a message'],
              ['standup', '🗒', 'Standup'],
              ['view:costs', '$', 'Costs'],
              ['view:janitor', '🧹', 'Janitor'],
              ['view:history', '🔎', 'Search history'],
              ['settings', '⚙', 'Settings'],
            ] as [PaletteAction | 'palette', string, string][]
          ).map(([a, icon, title]) => (
            <button key={a} className={`tool ${view === a.replace('view:', '') ? 'on' : ''}`} title={title} onClick={() => onTool(a as PaletteAction)}>
              {icon}
            </button>
          ))}
        </div>
        {state.missingBinaries.length > 0 && <div className="err">Not found on PATH: {state.missingBinaries.join(', ')}</div>}
        {state.errors.slice(0, 3).map((e) => (
          <div key={e} className="err" title={e}>
            {e.length > 90 ? e.slice(0, 90) + '…' : e}
          </div>
        ))}
        {formatGhCache(state.ghCache, now) && (
          <div className={state.ghCache?.pausedUntil ? 'err' : 'line'} title={state.ghCache?.pauseReason ?? 'One cache (~/.claude/gh-cache) shared by MasterDeck, master and the babysit skills'}>
            {formatGhCache(state.ghCache, now)}
          </div>
        )}
        <div className="line">
          <span title={state.githubRefreshedAt ? new Date(state.githubRefreshedAt).toLocaleString() : ''}>
            {state.githubRefreshing
              ? 'Refreshing from GitHub…'
              : state.githubRefreshedAt
                ? `Refreshed ${formatRefreshed(now - state.githubRefreshedAt)}`
                : 'Not refreshed yet'}
          </span>
          <span style={{ flex: 1 }} />
          <button className="link-btn" onClick={refresh} disabled={refreshing || state.githubRefreshing}>
            {refreshing || state.githubRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
    </aside>
  )
}

/** Close (X) on a Needs-you card: hides it until the situation changes. */
function CloseX({ onClose }: { onClose: () => void }) {
  return (
    <button
      className="card-x"
      title="Close"
      aria-label="Close"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      ×
    </button>
  )
}

/**
 * What a closed card is remembered by. Each key includes what would make the card worth showing
 * again: new activity in the session, a proposal's new status, another 10% of context, another
 * multiple of the budget.
 */
function needsDismissKey(item: NeedsItem, state: AppState): string {
  if (item.kind === 'session') return `x:s:${item.session.key}:${state.lastActivity[item.session.sessionId] ?? 0}`
  return `x:p:${item.proposal.id}:${item.proposal.status}`
}

function extraKey(x: Extra, state: AppState): string {
  switch (x.kind) {
    case 'nudge':
      return `x:n:${x.nudge.session.key}:${x.nudge.kind}:${state.lastActivity[x.nudge.session.sessionId] ?? 0}`
    case 'context':
      return `x:c:${x.session.key}:${Math.floor(x.pct / 10)}`
    case 'budget':
      return `x:b:${x.issue}:${Math.floor(x.spend / x.cap)}`
  }
}

function needsKey(item: NeedsItem): string {
  return item.kind === 'session' ? `s:${item.session.key}` : `p:${item.proposal.id}`
}

function SessionRow({ s, active, now, onClick }: { s: Session; active: boolean; now: number; onClick: () => void }) {
  return (
    <div className={`row ${active ? 'active' : ''}`} onClick={onClick} title={`${s.name}\n${s.cwd}\n${s.kind} · ${s.rawState}`}>
      <span className={`dot ${s.state}`} />
      <span className="label">{s.name}</span>
      {s.issue !== null && <span className="num">#{s.issue}</span>}
      <span className="sub">{s.kind === 'interactive' ? 'ext' : STATE_LABEL[s.state]}</span>
      <span className="sub">{s.startedAt ? formatAgo(now - s.startedAt) : ''}</span>
    </div>
  )
}

function NeedsCard({ item, state, onOpenSession, onIssue, onClose }: { item: NeedsItem; state: AppState; onOpenSession: (s: Session) => void; onIssue: (i: Issue) => void; onClose: () => void }) {
  if (item.kind === 'session') {
    const s = item.session
    return (
      <div className="card" style={{ ['--kind' as string]: 'var(--red)' }} onClick={() => onOpenSession(s)}>
        <CloseX onClose={onClose} />
        <div className="top">
          <span className="kind">INPUT</span>
          <span className="title">{s.name}</span>
        </div>
        <div className="body">Waiting on a prompt or permission. Click to open.</div>
      </div>
    )
  }
  return <ProposalCard proposal={item.proposal} attention={item.kind === 'attention'} state={state} onOpenSession={onOpenSession} onIssue={onIssue} onClose={onClose} />
}

function ProposalCard({
  proposal: p,
  attention,
  state,
  onOpenSession,
  onIssue,
  onClose,
}: {
  proposal: Proposal
  attention: boolean
  state: AppState
  onOpenSession: (s: Session) => void
  onIssue: (i: Issue) => void
  onClose: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const target = sessionForProposal(p, state.sessions)
  const dest = p.target.session ? `→ ${p.target.session}` : p.target.spawn ? `→ spawn ${p.target.spawn.name}` : ''

  const decide = async (approve: boolean) => {
    setBusy(true)
    setError(null)
    const r = approve ? await deck().approve(p.id) : await deck().reject(p.id)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  return (
    <div className="card" style={{ ['--kind' as string]: KIND_COLOR[p.kind] ?? 'var(--accent)' }}>
      <CloseX onClose={onClose} />
      <div className="top">
        <span className="kind">{attention ? p.status.toUpperCase() : p.kind}</span>
        <span className="title" title={`#${p.issue} ${dest}`}>
          #{p.issue} {dest}
        </span>
        <button className="icon-btn" onClick={() => setOpen(!open)} title={open ? 'Hide message' : 'Show the message master will send'}>
          {open ? '▴' : '▾'}
        </button>
      </div>
      <div className="body">{attention && p.note ? p.note : p.summary}</div>
      {open && <pre>{p.message}</pre>}
      {attention && p.status === 'question' && target && <QuickReply session={target} />}
      <div className="actions">
        {error && <span className="error">{error}</span>}
        {target && (
          <button className="btn" onClick={() => onOpenSession(target)}>
            Open
          </button>
        )}
        {!attention && (
          <>
            <button className="btn" disabled={busy} onClick={() => decide(false)}>
              Reject
            </button>
            {p.kind === 'ASSIGN' && p.target.spawn ? (
              // Opens the Start dialog: review the prompt, add first instructions, start now.
              <button
                className="btn primary"
                onClick={() =>
                  onIssue(
                    state.issues.find((i) => i.number === p.issue) ?? {
                      number: p.issue,
                      title: p.summary.replace(/^"|"$/g, ''),
                      url: issueUrl(p.issue),
                      status: null,
                      currentSprint: true,
                      assignedToMe: true,
                    },
                  )
                }
              >
                Start…
              </button>
            ) : (
              <button className="btn primary" disabled={busy} onClick={() => decide(true)}>
                Approve
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

type Extra =
  | { id: string; kind: 'nudge'; nudge: Nudge }
  | { id: string; kind: 'context'; session: Session; pct: number }
  | { id: string; kind: 'budget'; issue: number; spend: number; cap: number }

/** Needs-you items the app derives itself: idle/waiting nudges, context warnings, budgets. */
function useExtras(state: AppState, now: number): Extra[] {
  return useMemo(() => {
    const out: Extra[] = []
    for (const n of idleNudges(state.sessions, state.proposals, state.lastActivity, state.settings.idleNudgeMinutes, now)) {
      // A session already listed as needing input keeps that card; add the wait time only for others.
      if (n.kind === 'waiting' && state.needsYou.some((i) => i.kind === 'session' && i.session.key === n.session.key)) continue
      out.push({ id: `n:${n.session.key}`, kind: 'nudge', nudge: n })
    }
    for (const s of state.sessions) {
      const pct = state.allStats[s.sessionId]?.contextPct
      if (s.state !== 'done' && s.name !== MASTER_NAME && pct != null && pct >= state.settings.contextWarnPct)
        out.push({ id: `c:${s.key}`, kind: 'context', session: s, pct })
    }
    const cap = state.settings.budgetPerTicketUsd
    if (cap > 0)
      for (const [issue, spend] of Object.entries(ticketSpend(state.costBook)))
        if (spend > cap) out.push({ id: `b:${issue}`, kind: 'budget', issue: Number(issue), spend, cap })
    return out
  }, [state, now])
}

function ExtraCard({ x, state, onOpenSession, onClose }: { x: Extra; state: AppState; onOpenSession: (s: Session) => void; onClose: () => void }) {
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const send = async (s: Session, text: string) => {
    setBusy(true)
    const r = await deck().sendText(s.key, text)
    setBusy(false)
    setMsg(r.ok ? 'Sent' : r.message)
  }
  if (x.kind === 'nudge') {
    const s = x.nudge.session
    return (
      <div className="card" style={{ ['--kind' as string]: 'var(--amber)' }}>
        <CloseX onClose={onClose} />
        <div className="top">
          <span className="kind">{x.nudge.kind === 'idle' ? `IDLE ${x.nudge.minutes}M` : `WAITING ${x.nudge.minutes}M`}</span>
          <span className="title">{s.name}</span>
        </div>
        <div className="body">{x.nudge.kind === 'idle' ? 'Working a ticket but quiet. Nudge it to carry on?' : 'Blocked on a prompt. Open it to answer.'}</div>
        <div className="actions">
          {msg && <span className="error" style={{ color: msg === 'Sent' ? 'var(--green)' : undefined }}>{msg}</span>}
          <button className="btn" onClick={() => onOpenSession(s)}>
            Open
          </button>
          {x.nudge.kind === 'idle' && (
            <button className="btn primary" disabled={busy} onClick={() => send(s, 'continue')}>
              Continue
            </button>
          )}
        </div>
      </div>
    )
  }
  if (x.kind === 'context') {
    return (
      <div className="card" style={{ ['--kind' as string]: 'var(--red)' }}>
        <CloseX onClose={onClose} />
        <div className="top">
          <span className="kind">CONTEXT {Math.round(x.pct)}%</span>
          <span className="title">{x.session.name}</span>
        </div>
        <div className="body">Near the context limit. Compacting keeps it working well.</div>
        <div className="actions">
          {msg && <span className="error" style={{ color: msg === 'Sent' ? 'var(--green)' : undefined }}>{msg}</span>}
          <button className="btn" onClick={() => onOpenSession(x.session)}>
            Open
          </button>
          <button className="btn primary" disabled={busy} onClick={() => send(x.session, '/compact')}>
            Compact now
          </button>
        </div>
      </div>
    )
  }
  const owner = sessionForIssue(state.sessions, x.issue)
  return (
    <div className="card" style={{ ['--kind' as string]: 'var(--red)' }}>
      <CloseX onClose={onClose} />
      <div className="top">
        <span className="kind">BUDGET</span>
        <span className="title">
          #{x.issue} spent {formatCost(x.spend)} of {formatCost(x.cap)}
        </span>
      </div>
      <div className="body">Its sessions passed the per-ticket budget (Settings).</div>
      {owner && (
        <div className="actions">
          <button className="btn" onClick={() => onOpenSession(owner)}>
            Open {owner.name}
          </button>
        </div>
      )}
    </div>
  )
}

/** Answer a session's question from the card: typed into the session like a reply in its tab. */
function QuickReply({ session }: { session: Session }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    const r = await deck().sendText(session.key, text)
    setBusy(false)
    setMsg(r.ok ? `Sent to ${session.name}` : r.message)
    if (r.ok) setText('')
  }
  return (
    <div className="quick-reply" onClick={(e) => e.stopPropagation()}>
      <textarea
        value={text}
        placeholder={`Reply to ${session.name}…`}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void send()}
      />
      <div className="actions">
        {msg && <span className="error" style={{ color: msg.startsWith('Sent') ? 'var(--green)' : undefined }}>{msg}</span>}
        <button className="btn primary" disabled={busy || !text.trim()} onClick={send} title="⌘↵">
          {busy ? 'Sending…' : 'Reply'}
        </button>
      </div>
    </div>
  )
}
