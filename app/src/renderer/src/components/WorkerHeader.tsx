import { issueUrl as issueUrlFor } from '@shared/appConfig'
import { useEffect, useRef, useState } from 'react'
import { formatAgo, formatCost, formatDiff, formatLeft, formatPct, shortPath } from '@shared/format'
import { contextLevel } from '@shared/stats'
import { formatTokens, tokenSum, tokenTitle } from '@shared/tokens'
import { sessionStatus } from '@shared/review'
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

const STATUS_TEXT: Record<string, string> = {
  'ready for review': 'Ready for Review',
  merged: 'Merged',
}

export function WorkerHeader({ session: s, state, onDetach, onAskMaster, masterAttached, queueOpen, onToggleQueue, summaryOpen, onToggleSummary }: Props) {
  const now = useNow(1000)
  const [menu, setMenu] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const since = useStateSince(s)
  const review = state.review[s.key] ?? null
  const merged = state.merged[s.key] ?? null
  const status = sessionStatus(s.state, review, merged, now)
  const statusTitle = merged
    ? `PR ${merged.map((n) => `#${n}`).join(', ')} merged`
    : review
      ? `PR ${review.prs.map((n) => `#${n}`).join(', ')}: last comment or review ${formatAgo(now - review.since)} ago. Ready for Review after ${state.settings.reviewQuietMinutes} minutes without new ones (Settings).`
      : `raw: ${s.rawState}`
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

  const issue = s.issue !== null ? state.issues.find((i) => i.number === s.issue) : undefined
  const issueLink = issue?.url ?? (s.issue !== null ? issueUrlFor(s.issue) : null)
  // Every PR the session has (a session can open several, across repos), newest first. With none
  // of its own, the PRs that reference its issue.
  const linked = state.sessionPrs[s.sessionId] ?? []
  const issuePrs = s.issue !== null ? state.prs.filter((p) => p.refsIssue === s.issue).map((p) => p.url) : []
  const prUrls = [...new Set(linked.length ? linked : issuePrs)].reverse()
  const git = state.git[s.sessionId]
  const stats = state.stats[s.sessionId]
  const tail = state.tails[s.sessionId]
  const dir = stats?.currentDir ?? tail?.cwd ?? s.cwd
  const branch = git?.branch ?? tail?.gitBranch ?? null
  const level = contextLevel(stats?.contextPct ?? null)

  const copy = (text: string, what: string) => {
    deck().copy(text)
    flash(`Copied ${what}`)
  }

  return (
    <div className="hdr">
      <div className="r">
        {issueLink ? (
          <span className="chip btnlike" onClick={() => deck().openExternal(issueLink)} title={issue?.title ?? ''}>
            Issue #{s.issue} ↗
          </span>
        ) : (
          <span className="chip muted">No issue</span>
        )}
        {prUrls.length === 0 && <span className="chip muted">No PR</span>}
        {prUrls.map((u) => (
          <PrChip key={u} url={u} state={state} many={prUrls.length > 1} />
        ))}
        {branch && (
          <span className="chip copyable mono" onClick={() => copy(branch, 'branch')} title="Click to copy the branch">
            ⎇ {branch}
            {git && (git.ahead > 0 || git.behind > 0) && (
              <span className="muted">
                ↑{git.ahead} ↓{git.behind}
              </span>
            )}
          </span>
        )}
        {dir && (
          <span className="chip path copyable mono" onClick={() => copy(dir, 'path')} title={`${dir}\nClick to copy`}>
            <span>📁 {shortPath(dir, deck().home)}</span>
          </span>
        )}
        {dir && (
          <span
            className="chip btnlike"
            onClick={async () => {
              const r = await deck().openEditor(dir)
              flash(r.ok ? r.message : `Editor: ${r.message}`)
            }}
          >
            Open in editor
          </span>
        )}
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
        <span className={`chip ${status.dot === 'review' || status.dot === 'merged' ? `st-chip-${status.dot}` : ''}`} title={statusTitle}>
          <span className={`dot ${status.dot}`} />
          {status.countdown !== null ? (
            <>
              Ready for Review in <b>{formatLeft(status.countdown)}</b>
            </>
          ) : (
            STATUS_TEXT[status.text] ?? status.text
          )}
          {since !== null && status.countdown === null && status.dot !== 'review' && status.dot !== 'merged' && <span className="muted"> · {formatAgo(now - since)}</span>}
        </span>
        {s.state === 'working' && review && (
          <span className={`chip ${review.ready ? 'st-chip-review' : ''}`} title={statusTitle}>
            {review.ready ? 'PR quiet: Ready for Review' : <>Ready for Review in <b>{formatLeft(review.readyAt - now)}</b></>}
          </span>
        )}
        <span className="chip" title={stats?.source === 'transcript' ? 'Install the status line hook for exact cost' : 'Session cost so far'}>
          {formatCost(stats?.costUsd ?? null)}
        </span>
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
        {(stats?.permissionMode ?? tail?.permissionMode) && (
          <span className="chip muted">mode: {stats?.permissionMode ?? tail?.permissionMode}</span>
        )}
        <span className="chip muted">{git ? formatDiff(git) : 'diff —'}</span>
        {tail?.lastTool && (
          <span className="chip muted" title="Last tool the session used">
            last tool: {tail.lastTool}
            {tail.lastToolAt && ` · ${formatAgo(now - tail.lastToolAt)}`}
          </span>
        )}
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
