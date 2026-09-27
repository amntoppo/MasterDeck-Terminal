import { useMemo, useState } from 'react'
import { issueUrl } from '@shared/appConfig'
import { MASTER_NAME } from '@shared/derive'
import { formatAgo, formatCost, formatPct } from '@shared/format'
import { attentionFor, sessionStatus } from '@shared/review'
import { activityOf, LANES, laneOf, STEPS, taskStep, type Lane, type TaskStep } from '@shared/tasks'
import { sameTicket, ticketLabel } from '@shared/ticket'
import type { AppState, Session } from '@shared/types'
import { deck, load, save, useNow } from '../deck'

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
  onPr: (url: string) => void
}

interface Task {
  s: Session
  status: ReturnType<typeof sessionStatus>
  step: TaskStep
  lane: Lane
  title: string
}

/**
 * Every session as a task: which step it is on (Started → Coding → PR open → Review → Merged),
 * what it is doing right now, and its PRs, grouped by what it needs from you.
 */
export function TasksView({ state, onOpenSession, onPr }: Props) {
  const now = useNow()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => load('tasksCollapsed', { parked: true }))
  const toggle = (id: Lane) =>
    setCollapsed((cur) => {
      const next = { ...cur, [id]: !cur[id] }
      save('tasksCollapsed', next)
      return next
    })

  const tasks = useMemo<Task[]>(
    () =>
      state.sessions
        .filter((s) => s.name !== MASTER_NAME && s.state !== 'done')
        .map((s) => {
          const status = sessionStatus(s, state.prStage[s.key], attentionFor(s, state.proposals), state.manualStatus[s.key])
          const issue = s.issue !== null ? state.issues.find((i) => sameTicket(i, { repo: s.issueRepo ?? null, number: s.issue! })) : undefined
          return { s, status, step: taskStep(status.key, state.prStage[s.key], !!status.manual), lane: laneOf(status.key), title: issue?.title ?? s.name }
        }),
    [state.sessions, state.prStage, state.proposals, state.manualStatus, state.issues],
  )
  const byLane = (id: Lane) => tasks.filter((t) => t.lane === id).sort((a, b) => lastAt(state, b.s) - lastAt(state, a.s))
  const active = tasks.filter((t) => t.lane !== 'parked')

  const jump = (key: string) => document.getElementById(`task-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  return (
    <section className="board-view tasks-view">
      <header className="board-head">
        <h2>Tasks</h2>
        <span className="muted">
          {active.length} active
          {(() => {
            const n = active.filter((t) => activityOf(t.s).key === 'idle').length
            return n ? <span className="tv-count lane-idle"> · {n} idle</span> : null
          })()}
          {LANES.filter((l) => l.id !== 'parked' && l.id !== 'idle').map((l) => {
            const n = tasks.filter((t) => t.lane === l.id).length
            return n ? <span key={l.id} className={`tv-count lane-${l.id}`}> · {n} {l.title.toLowerCase()}</span> : null
          })}
        </span>
      </header>
      <div className="tv-scroll">
        {/* Where everything stands: one column per step, a pill per task */}
        <div className="tv-flow">
          {STEPS.map((name, i) => {
            const here = active.filter((t) => t.step.at === i)
            return (
              <div key={name} className={`tv-stage ${here.length ? '' : 'empty'}`}>
                <div className="tv-stage-n">{here.length}</div>
                <div className="tv-stage-head">{name}</div>
                <div className="tv-pills">
                  {here.map((t) => (
                    <button key={t.s.key} className={`tv-pill tone-${t.step.tone}`} onClick={() => jump(t.s.key)} title={`${t.title}\n${t.status.text}${t.step.note ? ` · ${t.step.note}` : ''}`}>
                      <span className="tv-pill-dot" />
                      {t.s.issue !== null ? ticketLabel(t.s.issueRepo, t.s.issue) : t.s.name}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {tasks.length === 0 && (
          <div className="welcome" style={{ padding: 60 }}>
            <h2>No tasks running</h2>
            <div>Start a session from a ticket on the board, or from ⌘K. It shows up here with its progress.</div>
          </div>
        )}

        {LANES.map((l) => {
          const list = byLane(l.id)
          if (!list.length) return null
          return (
            <div key={l.id} className={`tv-lane lane-${l.id}`}>
              <button className="tv-lane-head" onClick={() => toggle(l.id)} title={l.hint}>
                <span className="caret">{collapsed[l.id] ? '▸' : '▾'}</span>
                <span className="tv-lane-title">{l.title}</span>
                <span className="count">{list.length}</span>
              </button>
              {!collapsed[l.id] && list.map((t) => <TaskRow key={t.s.key} t={t} state={state} now={now} onOpen={() => onOpenSession(t.s)} onPr={onPr} />)}
            </div>
          )
        })}
      </div>
    </section>
  )
}

const lastAt = (state: AppState, s: Session): number => state.tails[s.sessionId]?.lastActivityAt ?? state.lastActivity[s.sessionId] ?? s.startedAt

function TaskRow({ t, state, now, onOpen, onPr }: { t: Task; state: AppState; now: number; onOpen: () => void; onPr: (url: string) => void }) {
  const { s, status, step } = t
  const tail = state.tails[s.sessionId]
  const stats = state.stats[s.sessionId] ?? state.allStats[s.sessionId]
  const git = state.git[s.sessionId]
  const prs = (state.sessionPrs[s.sessionId] ?? []).map((u) => state.prLive[u] ?? { url: u, number: Number(u.split('/').pop()), state: 'OPEN', ci: null, reviewDecision: null })
  const at = lastAt(state, s)
  const ask = state.asks[s.key]
  const menu = state.menus[s.key]
  const act = activityOf(s)

  // What it is doing right now, in one line.
  let now1: string
  if (menu?.question) now1 = `Asks: ${menu.question.question}`
  else if (status.key === 'needs-input') now1 = ask?.said?.text ? `Asks: ${ask.said.text}` : 'Waiting on a prompt or a permission'
  else if (status.key === 'question' || status.key === 'blocked') now1 = status.why
  else if (status.key === 'working') now1 = tail?.lastTool ? `Running ${tail.lastTool}` : ''
  else if (act.key === 'question' && s.asking) now1 = `Asks: ${s.asking.replace(/\s+/g, ' ').slice(-240)}`
  else if (act.key === 'waiting' && s.waitingOn) now1 = `Waiting on ${s.waitingOn}`
  else if (status.why) now1 = status.why
  else now1 = status.key === 'idle' ? 'Waiting for instructions' : ''

  return (
    <div id={`task-${s.key}`} className={`tv-row tone-${step.tone}`} onDoubleClick={onOpen}>
      <div className="tv-main">
        <div className="tv-title">
          {s.issue !== null && (
            <button className="tv-ticket" onClick={() => deck().openExternal(issueUrl(s.issue!, s.issueRepo))} title="Open the ticket on GitHub">
              {ticketLabel(s.issueRepo, s.issue)}
            </button>
          )}
          <span className="tv-name">{t.title}</span>
        </div>
        <div className="tv-meta">
          <span className="mono">{s.name}</span>
          {(git?.branch || tail?.gitBranch) && <span className="mono"> · {git?.branch ?? tail?.gitBranch}</span>}
          <span> · started {formatAgo(now - s.startedAt)} ago</span>
        </div>
        <Stepper step={step} />
      </div>
      <div className="tv-now">
        <div className="tv-chips">
          <span className={`tv-status tone-${step.tone}`} title={status.why || undefined}>
            {status.key === 'working' && <span className="tv-spin" />}
            {status.text}
          </span>
          {act.text !== status.text && (
            <span className={`tv-act act-${act.key}`} title={act.key === 'idle' ? 'Nothing running and no question: waiting for your next instruction' : act.key === 'waiting' ? s.waitingOn ?? '' : ''}>
              {act.key === 'working' && <span className="tv-spin" />}
              {act.text}
            </span>
          )}
        </div>
        {now1 && (
          <div className="tv-now-text" title={now1}>
            {now1}
          </div>
        )}
        <div className="tv-now-age">{at ? `last activity ${formatAgo(now - at)} ago` : ''}</div>
      </div>
      <div className="tv-side">
        <div className="tv-prs">
          {prs.length === 0 && <span className="muted">No PR yet</span>}
          {prs.slice(-3).map((p) => (
            <button key={p.url} className={`tv-pr pr-${String(p.state).toLowerCase()}`} onClick={() => onPr(p.url)} title={`${p.url}\nCI: ${p.ci ?? '—'} · review: ${p.reviewDecision ?? '—'}`}>
              #{p.number}
              <span className={`tv-ci ci-${p.ci ?? 'none'}`} />
              {p.state === 'MERGED' ? ' merged' : p.reviewDecision === 'APPROVED' ? ' approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? ' changes' : ''}
            </button>
          ))}
        </div>
        <div className="tv-stats">
          {git && (git.added || git.removed) ? (
            <span>
              <span className="ok">+{git.added}</span> <span className="bad">−{git.removed}</span> · {git.files} file{git.files === 1 ? '' : 's'}
            </span>
          ) : null}
          {stats?.costUsd != null && <span>{formatCost(stats.costUsd)}</span>}
          {stats?.contextPct != null && (
            <span className="tv-ctx" title={`Context used: ${formatPct(stats.contextPct)}`}>
              <i style={{ width: `${Math.min(100, stats.contextPct)}%` }} className={stats.contextPct > 80 ? 'hi' : ''} />
            </span>
          )}
        </div>
        <button className="btn" onClick={onOpen}>
          Open
        </button>
      </div>
    </div>
  )
}

/** Five segments, one per step: done ones filled, the current one in its tone, then its name. */
function Stepper({ step }: { step: TaskStep }) {
  return (
    <div className={`tv-steps tone-${step.tone}`} title={STEPS.map((n, i) => `${i < step.at ? '✓' : i === step.at ? '▶' : '·'} ${n}`).join('\n')}>
      <div className="tv-bar">
        {STEPS.map((name, i) => (
          <i key={name} className={i < step.at || (i === step.at && step.tone === 'done') ? 'past' : i === step.at ? 'here' : ''} />
        ))}
      </div>
      <span className="tv-step-name">
        <b>
          {step.at + 1}/{STEPS.length} {STEPS[step.at]}
        </b>
        {step.note ? ` · ${step.note}` : ''}
      </span>
    </div>
  )
}
