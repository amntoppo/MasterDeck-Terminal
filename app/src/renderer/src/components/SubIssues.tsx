import { useEffect, useId, useState, type CSSProperties } from 'react'
import { subIssueProgress, subIssueRows, type SubIssue, type SubIssueRow } from '@shared/subIssues'
import { ticketKey, ticketLabel, ticketOf, ticketUrl, type Ticket } from '@shared/ticket'
import type { AppState } from '@shared/types'
import { deck } from '../deck'
import { MarkdownView } from './MarkdownView'

/** A ticket's sub-issues, read from GitHub when the popup opens: null while loading. */
export function useSubIssues(t: Ticket): { subs: SubIssue[] | null; error: string | null } {
  const [subs, setSubs] = useState<SubIssue[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setSubs(null)
    setError(null)
    Promise.resolve(deck().issueSubIssues(ticketOf(t))).then(
      (r) => {
        if (!alive) return
        if (r.ok) setSubs(r.subIssues)
        else {
          setSubs([])
          setError(r.message)
        }
      },
      (e) => {
        if (!alive) return
        setSubs([])
        setError(String(e))
      },
    )
    return () => {
      alive = false
    }
  }, [t.repo, t.number])
  return { subs, error }
}

/** Which sub-issues are open, by ticketKey; several at once, forgotten when the list closes. */
export function useOpenSubs(): [Set<string>, (key: string) => void] {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  return [
    open,
    (key) =>
      setOpen((prev) => {
        const next = new Set(prev)
        if (!next.delete(key)) next.add(key)
        return next
      }),
  ]
}

/** An open sub-issue: its status, assignees, labels, description (Markdown) and a link to GitHub. */
export function SubIssueDetail({ row, id }: { row: SubIssueRow; id: string }) {
  const url = row.url || ticketUrl(row.repo, row.number)
  return (
    <div className="sub-detail" id={id}>
      <div className="sub-meta">
        <span className={`sub-status ${row.state}`}>{row.status}</span>
        {row.assignees.length ? (
          row.assignees.map((a) => (
            <span key={a} className="sub-assignee">
              @{a}
            </span>
          ))
        ) : (
          <span className="sub-none">No one assigned</span>
        )}
        {row.labels.map((l) => (
          <span
            key={l.name}
            className={`sub-label${l.color ? ' coloured' : ''}`}
            style={l.color ? ({ '--label': `#${l.color}` } as CSSProperties) : undefined}
          >
            {l.name}
          </span>
        ))}
      </div>
      {row.body ? (
        <div className="sub-body">
          <MarkdownView text={row.body} />
          {row.bodyCut && <div className="sub-cut">Cut short: open it on GitHub for the rest.</div>}
        </div>
      ) : (
        <div className="sub-none sub-empty">No description.</div>
      )}
      <button type="button" className="d-link sub-open" onClick={() => deck().openExternal(url)}>
        Open on GitHub ↗
      </button>
    </div>
  )
}

/** The rows of the popups' list: each one opens in place (a button: click, Enter or Space). */
export function SubIssueList({ rows, open, onToggle }: { rows: SubIssueRow[]; open: Set<string>; onToggle: (key: string) => void }) {
  const base = useId()
  return (
    <ul className="sub-list">
      {rows.map((s, i) => {
        const key = ticketKey(s.repo, s.number)
        const isOpen = open.has(key)
        const id = `${base}-sub-${i}`
        return (
          <li key={key} className={isOpen ? 'open' : undefined}>
            <button
              type="button"
              className={`sub-row${s.done ? ' done' : ''}`}
              aria-expanded={isOpen}
              aria-controls={isOpen ? id : undefined}
              title={`${isOpen ? 'Hide' : 'Show'} ${ticketLabel(s.repo, s.number)}`}
              onClick={() => onToggle(key)}
            >
              <span className="sub-caret" aria-hidden="true">
                {isOpen ? '▾' : '▸'}
              </span>
              <span className="sub-num">{ticketLabel(s.repo, s.number)}</span>
              <span className="sub-title">{s.title}</span>
              <span className={`sub-status ${s.state}`}>{s.status}</span>
            </button>
            {isOpen && <SubIssueDetail row={s} id={id} />}
          </li>
        )
      })}
    </ul>
  )
}

interface Props {
  ticket: Ticket
  /** A sub-issue on the board (or in the Board's repository view) shows its column. */
  state: AppState
}

/** The Sub-issues section of the Board's popups: each one's number, title and status, and how many are done. */
export function SubIssues({ ticket, state }: Props) {
  const { subs, error } = useSubIssues(ticket)
  const [open, toggle] = useOpenSubs()
  // Nothing to say about a ticket with none: the section stays out of the way.
  if (subs !== null && !subs.length && !error) return null
  // The board's column wins over the repository view's (later cards win in subIssueRows).
  const rows = subIssueRows(subs ?? [], [...(state.repoView?.cards ?? []), ...(state.board?.cards ?? [])])
  return (
    <section className="sub-issues" aria-label="Sub-issues">
      <div className="sub-issues-head">
        <label>Sub-issues</label>
        {rows.length > 0 && <span className="sub-progress">{subIssueProgress(rows)}</span>}
      </div>
      {subs === null ? (
        <div className="meta">Loading the sub-issues from GitHub…</div>
      ) : error ? (
        <div className="meta error">Could not load the sub-issues: {error}</div>
      ) : (
        <SubIssueList rows={rows} open={open} onToggle={toggle} />
      )}
    </section>
  )
}
