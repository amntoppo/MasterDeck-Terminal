import { useEffect, useRef, useState } from 'react'
import { StatusDialog } from './StatusDialog'
import { WorktreesDialog } from './WorktreesDialog'
import { sameTicket, ticketLabel, ticketUrl } from '@shared/ticket'
import { sessionTicket } from '@shared/derive'
import { formatAgo, formatDiff, formatPct } from '@shared/format'
import { contextLevel } from '@shared/stats'
import { formatTokens, tokenSum, tokenTitle } from '@shared/tokens'
import { attentionFor, sessionStatus } from '@shared/review'
import type { AppState, Session } from '@shared/types'
import { deck, useNow } from '../deck'

interface Props {
  session: Session
  state: AppState
  onDetach: () => void
  onAskMaster: (s: Session) => void
  masterAttached: boolean
  /** The Queue panel (this session's /queue) is showing. */
  queueOpen: boolean
  onToggleQueue: () => void
  /** The Summary panel (what this session did) is showing. */
  summaryOpen: boolean
  onToggleSummary: () => void
}


export function WorkerHeader({ session: s, state, onDetach, onAskMaster, masterAttached, queueOpen, onToggleQueue, summaryOpen, onToggleSummary }: Props) {
  const now = useNow(1000)
  const [menu, setMenu] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const since = useStateSince(s)
  const status = sessionStatus(s, state.prStage[s.key], attentionFor(s, state.proposals), state.manualStatus[s.key])
  const [statusOpen, setStatusOpen] = useState(false)
  const [wtOpen, setWtOpen] = useState(false)
  const tokens = state.tokens[s.sessionId] ?? null

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const flash = (t: string) => {
    setNote(t)
    setTimeout(() => setNote(null), 1600)
  }

  const t = sessionTicket(s)
  const issue = t ? state.issues.find((i) => sameTicket(i, t)) : undefined
  const issueLink = issue?.url ?? (t ? ticketUrl(t.repo, t.number) : null)
  // Every PR the session has (a session can open several, across repos), newest first. With none
  // of its own, the PRs that reference its issue.
  const linked = state.sessionPrs[s.sessionId] ?? []
  const issuePrs = t ? state.prs.filter((p) => p.refsIssue !== null && sameTicket({ repo: p.refsRepo, number: p.refsIssue }, t)).map((p) => p.url) : []
  const prUrls = [...new Set(linked.length ? linked : issuePrs)].reverse()
  const git = state.git[s.sessionId]
  const stats = state.stats[s.sessionId]
  const tail = state.tails[s.sessionId]
  const dir = stats?.currentDir ?? tail?.cwd ?? s.cwd
  const branch = git?.branch ?? tail?.gitBranch ?? null
  const level = contextLevel(stats?.contextPct ?? null)

  const worktrees = state.sessionWorktrees[s.key] ?? []

  const copy = (text: string, what: string) => {
    deck().copy(text)
    flash(`Copied ${what}`)
  }

  return (
    <div className="hdr">
      <div className="r">
        {issueLink ? (
          <span className="chip btnlike" onClick={() => deck().openExternal(issueLink)} title={issue?.title ?? ''}>
            Issue {ticketLabel(s.issueRepo, s.issue ?? 0)} ↗
          </span>
        ) : (
          <span className="chip muted">No issue</span>
        )}
        {prUrls.length === 0 && <span className="chip muted">No PR</span>}
        {prUrls.map((u) => (
          <PrChip key={u} url={u} state={state} many={prUrls.length > 1} />
        ))}
        {/* With worktree chips, the branch is on each (hover); the folder's own branch would mislead. */}
        {branch && worktrees.length === 0 && (
          <span className="chip copyable mono" onClick={() => copy(branch, 'branch')} title="Click to copy the branch">
            ⎇ {branch}
            {git && (git.ahead > 0 || git.behind > 0) && (
              <span className="muted">
                ↑{git.ahead} ↓{git.behind}
              </span>
            )}
          </span>
        )}
        {/* The worktrees it made (any repo), in a popup, each with Open in editor. */}
        <span className="chip btnlike" onClick={() => setWtOpen(true)} title={worktrees.length ? worktrees.map((w) => w.path).join('\n') : dir}>
          Worktree
        </span>
        {wtOpen && <WorktreesDialog session={s} worktrees={worktrees} dir={dir} onClose={() => setWtOpen(false)} />}
        <span className={`chip btnlike ${queueOpen ? 'on' : ''}`} onClick={onToggleQueue} title={queueOpen ? 'Hide the queue' : "Show this session's /queue: prompts it runs after each response"}>
          Queue Prompts
        </span>
        <span className={`chip btnlike ${summaryOpen ? 'on' : ''}`} onClick={onToggleSummary} title={summaryOpen ? 'Hide the summary' : 'What this session did: goal, changes, decisions, open questions'}>
          Summary
        </span>
        {note && <span className="chip muted">{note}</span>}
        <div className="menu-wrap" ref={menuRef}>
          <button className="icon-btn" onClick={() => setMenu(!menu)} title="More">
            ⋯
          </button>
          {menu && (
            <div className="menu">
              <button onClick={() => { setMenu(false); onDetach() }}>Detach (close tab, keep session)</button>
              <button onClick={() => { setMenu(false); copy(`claude --resume ${s.sessionId}`, 'resume command') }}>Copy resume command</button>
              {s.bgId && <button onClick={() => { setMenu(false); copy(`claude attach ${s.bgId}`, 'attach command') }}>Copy attach command</button>}
              {state.config.masterEnabled && (
                <button disabled={!masterAttached} title={masterAttached ? 'Types the question into master (only when master is idle)' : 'master-agent is not attached here'} onClick={() => { setMenu(false); onAskMaster(s) }}>
                  Ask master about this session
                </button>
              )}
              {s.kind === 'background' && s.bgId && (
                <>
                  <hr />
                  <button
                    className="danger"
                    onClick={async () => {
                      setMenu(false)
                      const r = await deck().stopSession(s.bgId!, s.name)
                      if (r.message !== 'cancelled') flash(r.ok ? 'Stopped' : r.message)
                    }}
                  >
                    Stop session…
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="r">
        <span
          className={`chip btnlike st-chip st-${status.key}`}
          onClick={() => setStatusOpen(true)}
          title={`${status.why ? `${status.text}: ${status.why}\n` : ''}Click to set the status by hand, or stop the session\nraw: ${s.rawState}`}
        >
          <span className={`dot st-${status.key}`} />
          {status.text}
          {status.manual && <span className="muted"> (set)</span>}
          {since !== null && !status.manual && (status.key === 'working' || status.key === 'idle' || status.key === 'needs-input') && <span className="muted"> · {formatAgo(now - since)}</span>}
        </span>
        {statusOpen && <StatusDialog session={s} state={state} onClose={() => setStatusOpen(false)} onStopped={onDetach} />}
        <span className="chip" title={tokens ? `${tokenTitle(tokens)}\n(this session and its subagents, from the transcript)` : 'Counting tokens…'}>
          Tokens used <b>{formatTokens(tokens ? tokenSum(tokens) : null)}</b>
        </span>
        {(stats?.contextPct ?? 0) >= state.settings.contextWarnPct && (
          <span
            className="chip btnlike danger-chip"
            title="Types /compact into the session"
            onClick={async () => {
              const r = await deck().sendText(s.key, '/compact')
              flash(r.ok ? 'Compacting…' : r.message)
            }}
          >
            Compact now
          </span>
        )}
        <span className="chip" title={`Context used${stats?.source === 'transcript' ? ' (estimated from the transcript)' : ''}`}>
          ctx
          <span className={`bar ${level}`}>
            <i style={{ width: `${Math.min(100, stats?.contextPct ?? 0)}%` }} />
          </span>
          {formatPct(stats?.contextPct ?? null)}
        </span>
        {(stats?.model ?? tail?.model) && <span className="chip muted">{stats?.model ?? tail?.model}</span>}
        <span className="chip muted">{git ? formatDiff(git) : 'diff —'}</span>
        {s.kind === 'interactive' && <span className="chip muted">pid {s.pid} · outside the app</span>}
      </div>
    </div>
  )
}

/** When the session entered its current state, as seen by this window. */
function useStateSince(s: Session): number | null {
  const ref = useRef<{ id: string; state: string; since: number } | null>(null)
  if (!ref.current || ref.current.id !== s.sessionId || ref.current.state !== s.state) {
    ref.current = { id: s.sessionId, state: s.state, since: Date.now() }
  }
  return ref.current.since
}

/** One of the session's PRs: number (repo too when there are several), CI, review threads, review, state. */
function PrChip({ url, state, many }: { url: string; state: AppState; many: boolean }) {
  const live = state.prLive[url]
  const snap = state.prs.find((p) => p.url === url)
  const ci = live?.ci ?? (snap?.ci === 'success' ? 'success' : snap?.ci === 'failure' || snap?.ci === 'error' ? 'failure' : snap?.ci ? 'pending' : null)
  const threads = snap?.unresolvedThreads ?? 0
  const prState = live?.state ?? null
  const done = prState === 'MERGED' || prState === 'CLOSED'
  return (
    <span className={`chip btnlike ${done ? 'pr-done' : ''}`} onClick={() => deck().openExternal(url)} title={`${live?.title ?? snap?.title ?? ''}\n${url}`}>
      {many ? prLabel(url) : `PR #${live?.number ?? url.split('/').pop()}`} ↗
      {!done && ci === 'success' && <span className="ok">✓ CI</span>}
      {!done && ci === 'failure' && <span className="bad">✗ CI</span>}
      {!done && ci === 'pending' && <span className="wait">● CI</span>}
      {!done && threads > 0 && <span className="wait">💬 {threads}</span>}
      {!done && live?.reviewDecision === 'APPROVED' && <span className="ok">approved</span>}
      {!done && live?.reviewDecision === 'CHANGES_REQUESTED' && <span className="bad">changes requested</span>}
      {prState === 'MERGED' && <span className="merged">merged</span>}
      {prState === 'CLOSED' && <span className="muted">closed</span>}
    </span>
  )
}

/** `repo#123` from a PR URL. */
function prLabel(url: string): string {
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url)
  return m ? `${m[1]}#${m[2]}` : url
}
