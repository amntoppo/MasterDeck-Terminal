import { issueUrl as issueUrlFor } from '@shared/appConfig'
import { useEffect, useRef, useState } from 'react'
import { formatAgo, formatCost, formatDiff, formatPct, shortPath } from '@shared/format'
import { contextLevel } from '@shared/stats'
import { formatTokens, tokenSum, tokenTitle } from '@shared/tokens'
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
}

const STATE_TEXT: Record<string, string> = {
  working: 'working',
  idle: 'idle',
  'needs-input': 'needs input',
  suspended: 'suspended',
  done: 'ended',
}

export function WorkerHeader({ session: s, state, onDetach, onAskMaster, masterAttached, queueOpen, onToggleQueue }: Props) {
  const now = useNow(1000)
  const [menu, setMenu] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const since = useStateSince(s)
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
  const live = state.prLive[s.sessionId]
  const linked = state.sessionPrs[s.sessionId] ?? []
  const snapPrs = s.issue !== null ? state.prs.filter((p) => p.refsIssue === s.issue) : []
  const latestUrl = live?.url ?? linked.at(-1) ?? snapPrs[0]?.url ?? null
  const snapPr = state.prs.find((p) => p.url === latestUrl) ?? (live ? undefined : snapPrs[0])
  const prUrl = latestUrl
  const prNum = live?.number ?? snapPr?.number ?? (prUrl ? Number(prUrl.split('/').pop()) : null)
  // Earlier PRs this session opened (a session can open several, across repos).
  const others = [...new Set([...linked, ...snapPrs.map((p) => p.url)])].filter((u) => u !== prUrl).slice(-3)
  const ci = live?.ci ?? (snapPr?.ci === 'success' ? 'success' : snapPr?.ci === 'failure' || snapPr?.ci === 'error' ? 'failure' : snapPr?.ci ? 'pending' : null)
  const threads = snapPr?.unresolvedThreads ?? 0
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
        {prUrl ? (
          <span className="chip btnlike" onClick={() => deck().openExternal(prUrl)} title={`${live?.title ?? snapPr?.title ?? ''}\n${prUrl}`}>
            PR #{prNum} ↗
            {ci === 'success' && <span className="ok">✓ CI</span>}
            {ci === 'failure' && <span className="bad">✗ CI</span>}
            {ci === 'pending' && <span className="wait">● CI</span>}
            {threads > 0 && <span className="wait">💬 {threads}</span>}
            {live?.reviewDecision === 'APPROVED' && <span className="ok">approved</span>}
            {live?.reviewDecision === 'CHANGES_REQUESTED' && <span className="bad">changes requested</span>}
            {live && live.state !== 'OPEN' && <span className="wait">{live.state.toLowerCase()}</span>}
          </span>
        ) : (
          <span className="chip muted">No PR</span>
        )}
        {others.map((u) => (
          <span key={u} className="chip btnlike" onClick={() => deck().openExternal(u)} title={u}>
            {prLabel(u)} ↗
          </span>
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
              <button disabled={!masterAttached} title={masterAttached ? 'Types the question into master (only when master is idle)' : 'master-agent is not attached here'} onClick={() => { setMenu(false); onAskMaster(s) }}>
                Ask master about this session
              </button>
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
        <span className="chip" title={`raw: ${s.rawState}`}>
          <span className={`dot ${s.state}`} />
          {STATE_TEXT[s.state]}
          {since !== null && <span className="muted"> · {formatAgo(now - since)}</span>}
        </span>
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

/** `repo#123` from a PR URL. */
function prLabel(url: string): string {
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url)
  return m ? `${m[1]}#${m[2]}` : url
}
