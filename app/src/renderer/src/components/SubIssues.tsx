import { useEffect, useState } from 'react'
import { subIssueProgress, subIssueRows, type SubIssue } from '@shared/subIssues'
import { ticketLabel, ticketOf, ticketUrl, type Ticket } from '@shared/ticket'
import type { AppState } from '@shared/types'
import { deck } from '../deck'

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

interface Props {
  ticket: Ticket
  /** A sub-issue on the board (or in the Board's repository view) shows its column. */
  state: AppState
}

/** The Sub-issues section of the Board's popups: each one's number, title and status, and how many are done. */
export function SubIssues({ ticket, state }: Props) {
  const { subs, error } = useSubIssues(ticket)
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
        <ul className="sub-list">
          {rows.map((s) => (
            <li key={`${s.repo ?? ''}#${s.number}`}>
              <button
                type="button"
                className={`sub-row${s.done ? ' done' : ''}`}
                title={`Open ${ticketLabel(s.repo, s.number)} on GitHub`}
                onClick={() => deck().openExternal(s.url || ticketUrl(s.repo, s.number))}
              >
                <span className="sub-num">{ticketLabel(s.repo, s.number)}</span>
                <span className="sub-title">{s.title}</span>
                <span className={`sub-status ${s.state}`}>{s.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
