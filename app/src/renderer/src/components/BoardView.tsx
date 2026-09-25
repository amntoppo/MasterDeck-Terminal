import { getConfig, statusGroup, statusRank, type StatusGroup } from '@shared/appConfig'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cardBadge, cardsIn, visibleColumns } from '@shared/board'
import { applyFilters, cardAction, defaultFilters, filterOptions, UNASSIGNED, type FilterState } from '@shared/boardFilter'
import { ticketSpend } from '@shared/costs'
import { sessionForIssue } from '@shared/derive'
import { formatAgo, formatCost, formatPct, formatRefreshed } from '@shared/format'
import type { AppState, Badge, BoardCard, BoardPr, Session } from '@shared/types'
import { deck, load, save, useNow } from '../deck'

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
  /** My card without a session: the Start dialog. */
  onStart: (card: BoardCard) => void
  /** Someone else's card with a PR. */
  onPr: (card: BoardCard) => void
  /** Someone else's (or nobody's) card without a PR. */
  onAssign: (card: BoardCard) => void
  onSummary: () => void
}

const BADGE_ICON: Record<Badge['kind'], string> = {
  question: '❓',
  blocked: '⛔',
  'needs-input': '✋',
  onboarding: '⏳',
  working: '⚙️',
  done: '✅',
  idle: '💤',
  none: '○',
}

const COLUMN_COLOR: Record<string, string> = {
  'To Do': 'var(--grey)',
  'Ready For Dev': 'var(--accent)',
  'In Dev': 'var(--amber)',
  'PR Raised': 'var(--amber)',
  'Dev Done': '#f28b50',
  'In QA': 'var(--purple)',
  'QA Done': 'var(--green)',
  'Re-Open': 'var(--red)',
  Blocked: 'var(--red)',
}

const FILTERS_KEY = 'boardFilters'

const GROUP_COLOR: Record<StatusGroup, string> = {
  todo: 'var(--grey)',
  progress: 'var(--amber)',
  review: 'var(--amber)',
  done: 'var(--green)',
  blocked: 'var(--red)',
  other: 'var(--purple)',
}

function columnColor(col: string): string {
  const s = getConfig().statuses
  if (col === s.ready) return 'var(--accent)'
  if (col === s.devDone) return '#f28b50'
  return COLUMN_COLOR[col] ?? GROUP_COLOR[statusGroup(col)]
}

export function BoardView({ state, onOpenSession, onStart, onPr, onAssign, onSummary }: Props) {
  const now = useNow(15_000)
  const [refreshing, setRefreshing] = useState(false)
  // Drag and drop: a card shows in its new column at once; this is dropped when GitHub confirms or fails.
  const [moving, setMoving] = useState<Record<number, string>>({})
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [pendingMove, setPendingMove] = useState<{ card: BoardCard; to: string } | null>(null)
  const [moveMsg, setMoveMsg] = useState<string | null>(null)
  const spend = useMemo(() => ticketSpend(state.costBook), [state.costBook])

  const doMove = async (card: BoardCard, to: string) => {
    setMoving((m) => ({ ...m, [card.number]: to }))
    setMoveMsg(`Moving #${card.number} to ${to}…`)
    const r = await deck().setStatus(card.number, to)
    setMoving((m) => {
      const n = { ...m }
      delete n[card.number]
      return n
    })
    setMoveMsg(r.ok ? r.message : `Could not move #${card.number}: ${r.message}`)
    setTimeout(() => setMoveMsg(null), 5000)
  }
  const drop = (col: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const n = Number(e.dataTransfer.getData('text/masterdeck-card'))
    const card = state.board?.cards.find((c) => c.number === n)
    // Only statuses babysit-ticket can set (a column GitHub added later would fail as "unknown status").
    if (!card || !state.config.columns.includes(col) || (moving[n] ?? card.status) === col) return
    const back = statusRank(col) < statusRank(card.status ?? '')
    if (back) setPendingMove({ card, to: col })
    else void doMove(card, col)
  }
  const [filters, setFilters] = useState<FilterState | null>(() => load<FilterState | null>(FILTERS_KEY, null))
  const me = state.me
  // First run: filter to me once my login is known.
  useEffect(() => {
    if (!filters && me) setFilters(defaultFilters(me))
  }, [filters, me])
  useEffect(() => {
    if (filters) save(FILTERS_KEY, filters)
  }, [filters])
  const f = filters ?? defaultFilters(me)
  const set = (patch: Partial<FilterState>) => setFilters({ ...f, ...patch })

  const rawBoard = state.board
  const b = useMemo(
    () => (rawBoard && Object.keys(moving).length ? { ...rawBoard, cards: rawBoard.cards.map((c) => (moving[c.number] ? { ...c, status: moving[c.number] } : c)) } : rawBoard),
    [rawBoard, moving],
  )
  const shown = useMemo(() => (b ? applyFilters(b, f) : null), [b, f])
  const options = useMemo(() => (b ? filterOptions(b, me, state.users) : { assignees: [], labels: [], milestones: [] }), [b, me, state.users])

  const refresh = async () => {
    setRefreshing(true)
    await deck().refresh()
    setRefreshing(false)
  }

  const onCard = (card: BoardCard) => {
    const action = cardAction(card, me, state.sessions)
    if (action === 'session') {
      const s = sessionForIssue(state.sessions, card.number)
      if (s) onOpenSession(s)
    } else if (action === 'start') onStart(card)
    else if (action === 'pr') onPr(card)
    else onAssign(card)
  }

  const loading = state.boardLoading || state.githubRefreshing || refreshing
  const current = state.sprints.find((s) => !s.completed && inSprint(s.startDate, s.duration, now))
  const columns = shown ? visibleColumns(shown).filter((c) => !f.hiddenColumns.includes(c)) : []

  return (
    <section className="board-view">
      <header className="board-head">
        <select className="sprint-pick" value={state.selectedSprint} onChange={(e) => deck().setSprint(e.target.value)} title="Sprint">
          <option value="@current">Current sprint{current ? ` (${current.title})` : ''}</option>
          {state.sprints
            .filter((s) => s.title !== current?.title)
            .map((s) => (
              <option key={s.id} value={s.title}>
                {s.title} · {s.startDate}
                {s.completed ? '' : new Date(s.startDate).getTime() > now ? ' (upcoming)' : ''}
              </option>
            ))}
          <option value="none">No sprint</option>
        </select>
        <span className="muted">{b && shown ? `${shown.cards.length} of ${b.cards.length} issues` : ''}</span>
        {state.boardError && (
          <span className="board-error" title={state.boardError}>
            {state.boardError.length > 100 ? state.boardError.slice(0, 100) + '…' : state.boardError}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {moveMsg && <span className="muted">{moveMsg}</span>}
        <button className="btn" onClick={onSummary} title="Done, in progress, blocked and burndown">
          Summary
        </button>
        <span className="muted" title={state.githubRefreshedAt ? new Date(state.githubRefreshedAt).toLocaleString() : ''}>
          {loading ? 'refreshing from GitHub…' : state.githubRefreshedAt ? `refreshed ${formatRefreshed(now - state.githubRefreshedAt)}` : 'not refreshed yet'}
        </span>
        <button className="btn" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="filter-bar">
        <MultiPick
          label="Assignee"
          all="Everyone"
          values={f.assignees}
          options={[...options.assignees.map((u) => ({ value: u, label: u === me ? `${u} (me)` : u })), { value: UNASSIGNED, label: 'Unassigned' }]}
          onChange={(assignees) => set({ assignees })}
          quick={me ? [{ label: 'Me', values: [me] }, { label: 'Everyone', values: [] }] : []}
        />
        <MultiPick label="Labels" all="Any label" values={f.labels} options={options.labels.map((l) => ({ value: l, label: l }))} onChange={(labels) => set({ labels })} />
        <select className="fsel" value={f.milestone ?? ''} onChange={(e) => set({ milestone: e.target.value || null })}>
          <option value="">Any milestone</option>
          {options.milestones.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <select className="fsel" value={f.hasPr} onChange={(e) => set({ hasPr: e.target.value as FilterState['hasPr'] })}>
          <option value="any">PR: any</option>
          <option value="with">Has a PR</option>
          <option value="without">No PR</option>
        </select>
        <MultiPick
          label="Columns"
          all="All columns"
          values={b ? visibleColumns(b).filter((c) => !f.hiddenColumns.includes(c)) : []}
          options={(b ? visibleColumns(b) : []).map((c) => ({ value: c, label: c }))}
          onChange={(vis) => set({ hiddenColumns: (b ? visibleColumns(b) : []).filter((c) => !vis.includes(c)) })}
          invertAll
        />
        <input className="filter search" placeholder="Search title or #number" value={f.search} onChange={(e) => set({ search: e.target.value })} />
        {(f.labels.length > 0 || f.milestone || f.hasPr !== 'any' || f.search || f.hiddenColumns.length > 0 || f.assignees.join() !== (me ?? '')) && (
          <button className="link-btn" onClick={() => setFilters(defaultFilters(me))}>
            Reset filters
          </button>
        )}
      </div>

      {!b || !shown ? (
        <div className="welcome">
          {loading ? (
            <div>Loading board…</div>
          ) : (
            <>
              <h2>Board not loaded</h2>
              <div>{state.boardError ?? 'No data yet.'}</div>
              <button className="btn primary" onClick={refresh}>
                Retry
              </button>
            </>
          )}
        </div>
      ) : shown.cards.length === 0 ? (
        <div className="welcome">
          <h2>No issues match</h2>
          <div>{b.cards.length} issues in this sprint; the filters hide all of them.</div>
          <button className="btn" onClick={() => setFilters({ ...defaultFilters(me), assignees: [] })}>
            Show everyone's issues
          </button>
        </div>
      ) : (
        <div className="board-cols">
          {columns.map((col) => {
            const cards = cardsIn(shown, col)
            return (
              <div
                key={col}
                className={`board-col ${dragOver === col ? 'drop' : ''}`}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('text/masterdeck-card')) return
                  e.preventDefault()
                  setDragOver(col)
                }}
                onDragLeave={() => setDragOver((d) => (d === col ? null : d))}
                onDrop={(e) => drop(col, e)}
              >
                <div className="board-col-head">
                  <span className="ring" style={{ borderColor: columnColor(col) }} />
                  <strong>{col}</strong>
                  <span className="count">{cards.length}</span>
                </div>
                <div className="board-col-body">
                  {cards.map((c) => (
                    <Card key={c.number} card={c} state={state} me={me} now={now} spend={spend[c.number] ?? 0} moving={!!moving[c.number]} onClick={() => onCard(c)} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {pendingMove && (
        <div className="move-confirm">
          Move #{pendingMove.card.number} back from <b>{pendingMove.card.status}</b> to <b>{pendingMove.to}</b>?
          <button className="btn" onClick={() => setPendingMove(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              const m = pendingMove
              setPendingMove(null)
              void doMove(m.card, m.to)
            }}
          >
            Move back
          </button>
        </div>
      )}
    </section>
  )
}

function inSprint(start: string, days: number, now: number): boolean {
  const t = Date.parse(start)
  return Number.isFinite(t) && now >= t && now < t + days * 86_400_000
}

function Card({ card, state, me, now, spend, moving, onClick }: { card: BoardCard; state: AppState; me: string | null; now: number; spend: number; moving: boolean; onClick: () => void }) {
  const s = sessionForIssue(state.sessions, card.number)
  const mine = me !== null && card.assignees.includes(me)
  const badge = mine || s ? cardBadge(card.number, state.sessions, state.proposals) : null
  const action = cardAction(card, me, state.sessions)
  const stats = s ? state.stats[s.sessionId] : undefined
  return (
    <div
      className={`bcard ${mine ? 'mine' : ''} ${moving ? 'moving' : ''}`}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/masterdeck-card', String(card.number))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      title={action === 'session' ? `Open ${s?.name}` : action === 'start' ? 'Start a session' : action === 'pr' ? 'See the PR and review it' : 'Assign it'}
    >
      <div className="bcard-top">
        <span className="issue-ico">⊙</span>
        <span className="muted">{getConfig().issueRepo} #{card.number}</span>
        <span style={{ flex: 1 }} />
        {badge ? (
          <span className={`badge ${badge.kind}`} title={badge.detail ?? badge.label}>
            {BADGE_ICON[badge.kind]} {badge.label}
          </span>
        ) : (
          <span className="badge none">{action === 'pr' ? '🔍 Review PR' : '👤 Assign'}</span>
        )}
      </div>
      <div className="bcard-title">{card.title}</div>
      {(card.labels.length > 0 || card.type) && (
        <div className="bcard-labels">
          {card.type && <span className="lbl type">{card.type}</span>}
          {card.labels.map((l) => (
            <span key={l} className="lbl">
              {l}
            </span>
          ))}
        </div>
      )}
      {card.prs.length > 0 && (
        <div className="bcard-prs">
          {card.prs.map((p) => (
            <PrChip key={p.url} pr={p} />
          ))}
        </div>
      )}
      <div className="bcard-foot">
        {s ? (
          <>
            <span className={`dot ${s.state}`} />
            <span className="label">{s.name}</span>
            {stats?.costUsd != null && <span>{formatCost(stats.costUsd)}</span>}
            {stats?.contextPct != null && <span>ctx {formatPct(stats.contextPct)}</span>}
            {s.startedAt > 0 && <span>{formatAgo(now - s.startedAt)}</span>}
          </>
        ) : (
          <span className="label" />
        )}
        {spend > 0.005 && (
          <span className={`spend ${state.settings.budgetPerTicketUsd > 0 && spend > state.settings.budgetPerTicketUsd ? 'over' : ''}`} title="Spent by this ticket's sessions">
            {formatCost(spend)}
          </span>
        )}
        <Assignees logins={card.assignees} me={me} />
      </div>
    </div>
  )
}

function Assignees({ logins, me }: { logins: string[]; me: string | null }) {
  if (logins.length === 0) return <span className="avatar none" title="Unassigned">—</span>
  return (
    <span className="avatars">
      {logins.slice(0, 3).map((l) => (
        <span key={l} className={`avatar ${l === me ? 'me' : ''}`} title={l}>
          {initials(l)}
        </span>
      ))}
      {logins.length > 3 && <span className="avatar">+{logins.length - 3}</span>}
    </span>
  )
}

function initials(login: string): string {
  const parts = login.split(/[-_.]/).filter(Boolean)
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : login.slice(0, 2)
  return s.toUpperCase()
}

/** A dropdown of checkboxes. `invertAll` means an empty selection shows nothing (used for columns). */
function MultiPick(p: {
  label: string
  all: string
  values: string[]
  options: { value: string; label: string }[]
  onChange: (v: string[]) => void
  quick?: { label: string; values: string[] }[]
  invertAll?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const summary =
    p.invertAll
      ? p.values.length === p.options.length
        ? p.all
        : `${p.label}: ${p.values.length}/${p.options.length}`
      : p.values.length === 0
        ? p.all
        : p.values.length === 1
          ? `${p.label}: ${p.options.find((o) => o.value === p.values[0])?.label ?? p.values[0]}`
          : `${p.label}: ${p.values.length}`
  const toggle = (v: string) => p.onChange(p.values.includes(v) ? p.values.filter((x) => x !== v) : [...p.values, v])
  return (
    <div className="mpick" ref={ref}>
      <button className={`fsel ${p.values.length && !p.invertAll ? 'active' : ''}`} onClick={() => setOpen(!open)}>
        {summary} ▾
      </button>
      {open && (
        <div className="menu mpick-menu">
          {p.quick?.map((q) => (
            <button key={q.label} onClick={() => p.onChange(q.values)}>
              {q.label}
            </button>
          ))}
          {p.quick && p.quick.length > 0 && <hr />}
          {p.options.length === 0 && <div className="empty">Nothing to filter</div>}
          {p.options.map((o) => (
            <label key={o.value} className="mpick-row">
              <input type="checkbox" checked={p.values.includes(o.value)} onChange={() => toggle(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const PR_STATE_CLASS: Record<string, string> = { OPEN: 'open', DRAFT: 'draft', MERGED: 'merged', CLOSED: 'closed' }

function PrChip({ pr }: { pr: BoardPr }) {
  const cls = PR_STATE_CLASS[pr.state ?? ''] ?? 'unknown'
  const live = pr.state === 'OPEN' || pr.state === 'DRAFT'
  return (
    <span
      className={`prchip ${cls}`}
      title={`${pr.repo}#${pr.number} · ${pr.state?.toLowerCase() ?? 'unknown'}${pr.ci ? ` · CI ${pr.ci}` : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        deck().openExternal(pr.url)
      }}
    >
      <PrIcon />#{pr.number}
      {live && pr.ci === 'success' && <span className="ok">✓</span>}
      {live && pr.ci === 'failure' && <span className="bad">✗</span>}
      {live && pr.ci === 'pending' && <span className="wait">●</span>}
      {live && pr.unresolved > 0 && <span className="wait">💬 {pr.unresolved}</span>}
    </span>
  )
}

/** GitHub's git-pull-request octicon. */
export function PrIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  )
}
