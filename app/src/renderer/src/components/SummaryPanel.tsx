import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { ticketLabel } from '@shared/ticket'
import { formatAgo } from '@shared/format'
import type { SessionSummary } from '@shared/summary'
import type { AppState } from '@shared/types'
import { deck } from '../deck'

/** **bold** and `code` inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : <Fragment key={i}>{part}</Fragment>,
  )
}

/** The little markdown a summary uses: paragraphs, `- ` bullets, **bold**, `code`. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let items: string[] = []
  const flush = () => {
    if (items.length) blocks.push(<ul key={`u${blocks.length}`}>{items.map((t, i) => <li key={i}>{inline(t)}</li>)}</ul>)
    items = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (bullet) {
      items.push(bullet[1])
      continue
    }
    flush()
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line.replace(/^#+\s*/, ''))}</p>)
  }
  flush()
  return <div className="md">{blocks}</div>
}

/**
 * "What did it do?" for the focused session: goal, what it did, decisions, open questions, where it
 * stands. Made on request from the transcript (a one-off `claude -p`), saved, and postable on the issue.
 */
export function SummaryPanel({ state, activeKey, onClose }: { state: AppState; activeKey: string | null; onClose: () => void }) {
  const session = state.sessions.find((s) => s.key === activeKey) ?? null
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState<'make' | 'post' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const now = Date.now()

  const load = useCallback(async () => {
    setMsg(null)
    if (!activeKey) return setSummary(null)
    const r = await deck().summaryGet(activeKey)
    setSummary(r.summary)
    setStale(r.stale)
  }, [activeKey])
  useEffect(() => void load(), [load])

  const make = async () => {
    if (!session) return
    setBusy('make')
    setMsg(null)
    const r = await deck().summaryMake(session.key)
    setBusy(null)
    if (r.ok) {
      setSummary(r.summary)
      setStale(false)
    } else setMsg(r.message)
  }
  const post = async () => {
    if (!session) return
    setBusy('post')
    const r = await deck().summaryPost(session.key)
    setBusy(null)
    setMsg(r.ok ? `Posted on ${ticketLabel(session.issueRepo, session.issue ?? 0)}` : r.message)
  }

  return (
    <section className="queue summary-panel">
      <div className="mhead">
        <strong>Summary</strong>
        <span className="muted">{session ? session.name : 'no session'}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Hide the summary (Summary in a session's header shows it again)">
          ×
        </button>
      </div>
      <div className="queue-head">
        <span className="meta grow">
          {summary ? `Made ${formatAgo(now - summary.at)} ago${stale ? ' · the session has moved on since' : ''}` : session ? 'No summary yet.' : 'Open a session tab to see its summary.'}
        </span>
        {session && (
          <button className="btn" disabled={busy !== null} onClick={() => void make()} title="Read the transcript again and summarize it (a one-off claude -p with a small model, about 20 s)">
            {busy === 'make' ? 'Summarizing…' : summary ? 'Update' : 'Summarize'}
          </button>
        )}
        {session && summary && session.issue !== null && (
          <button className="btn" disabled={busy !== null} onClick={() => void post()} title={`Comment it on ${ticketLabel(session.issueRepo, session.issue ?? 0)}`}>
            {busy === 'post' ? 'Posting…' : 'Post to issue'}
          </button>
        )}
      </div>
      {msg && (
        <div className="banner" style={{ color: 'var(--muted)', background: 'var(--bg-2)' }} onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}
      <div className="summary-body">
        {busy === 'make' && !summary && <div className="empty">Reading the transcript and summarizing (about 20 seconds)…</div>}
        {summary && <Markdown text={summary.text} />}
      </div>
    </section>
  )
}
