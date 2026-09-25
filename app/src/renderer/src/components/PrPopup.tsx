import { useEffect, useRef, useState } from 'react'
import { composeReviewPrompt, pickPr, reviewName } from '@shared/boardFilter'
import type { AssignRequest } from '@shared/ipc'
import type { PrSummary } from '@shared/prSummary'
import type { AppState, BoardCard } from '@shared/types'
import { deck } from '../deck'
import { PrIcon } from './BoardView'

interface Props {
  card: BoardCard
  state: AppState
  onClose: () => void
  /** Start is fire-and-forget: the caller switches to the terminal and tracks the spawn. */
  onStartReview: (req: AssignRequest) => void
}

const STATE_LABEL: Record<string, string> = { OPEN: 'Open', DRAFT: 'Draft', MERGED: 'Merged', CLOSED: 'Closed' }

export function PrPopup({ card, state, onClose, onStartReview }: Props) {
  const [url, setUrl] = useState(() => pickPr(card.prs)?.url ?? card.prs[0]?.url ?? '')
  const [pr, setPr] = useState<PrSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [instructions, setInstructions] = useState('')
  const instructionsRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    setPr(null)
    setError(null)
    if (!url) return
    void deck()
      .prSummary(url)
      .then((r) => {
        if (!alive) return
        if (r.ok) setPr(r.pr)
        else setError(r.message)
      })
    return () => {
      alive = false
    }
  }, [url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (reviewing) instructionsRef.current?.focus()
  }, [reviewing])

  const start = () => {
    if (!pr) return
    const name = reviewName(pr.repo, pr.number, state.sessions)
    onStartReview({
      kind: 'PRREVIEW',
      issue: card.number,
      name,
      cwd: state.masterWorkspace,
      prompt: composeReviewPrompt({ url: pr.url, repo: pr.repo, number: pr.number, title: pr.title, author: pr.author, issue: card.number }, instructions),
      proposalId: null,
      edited: true,
      approved: false,
    })
    onClose()
  }

  const decision = pr ? reviewSummary(pr.reviews) : null
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label={`PR for #${card.number}`} style={{ borderTopColor: 'var(--accent)' }}>
        <h3>
          <span className="kind" style={{ ['--kind' as string]: 'var(--accent)' }}>
            PR
          </span>
          #{card.number} {card.title}
        </h3>
        <div className="meta">
          Assigned to {card.assignees.length ? card.assignees.join(', ') : 'nobody'} · {card.status ?? 'no status'} ·{' '}
          <button className="link-btn" onClick={() => deck().openExternal(card.url)}>
            issue ↗
          </button>
        </div>
        {card.prs.length > 1 && (
          <div className="pr-switch">
            {card.prs.map((p) => (
              <button key={p.url} className={`prchip ${(p.state ?? '').toLowerCase()} ${p.url === url ? 'sel' : ''}`} onClick={() => setUrl(p.url)}>
                <PrIcon />
                {p.repo}#{p.number}
              </button>
            ))}
          </div>
        )}
        {error ? (
          <p className="error">{error}</p>
        ) : !pr ? (
          <p className="meta">Loading the PR…</p>
        ) : (
          <>
            <div className="pr-title">
              <span className={`pr-state ${pr.state.toLowerCase()}`}>{STATE_LABEL[pr.state] ?? pr.state}</span>
              <strong>{pr.title}</strong>
              <span className="muted">
                {pr.owner}/{pr.repo}#{pr.number}
              </span>
            </div>
            <div className="pr-facts">
              <span>by @{pr.author}</span>
              <span className="mono">
                {pr.base} ← {pr.head}
              </span>
              <span>
                <span className="ok">+{pr.additions}</span> <span className="bad">−{pr.deletions}</span> · {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
              </span>
              <span>
                CI:{' '}
                {pr.checks.total === 0 ? (
                  'no checks'
                ) : (
                  <>
                    <span className="ok">{pr.checks.passed} ✓</span>
                    {pr.checks.failed > 0 && <span className="bad"> {pr.checks.failed} ✗</span>}
                    {pr.checks.pending > 0 && <span className="wait"> {pr.checks.pending} ●</span>}
                  </>
                )}
              </span>
              <span>Reviews: {decision}</span>
            </div>
            <pre className="pr-body">{pr.body.trim() || 'No description.'}</pre>
            {reviewing && (
              <>
                <label>Review instructions (optional)</label>
                <textarea
                  ref={instructionsRef}
                  className="instructions"
                  value={instructions}
                  placeholder="e.g. Focus on the notification permission flow and error handling; skip styling."
                  onChange={(e) => setInstructions(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && start()}
                />
                <div className="meta" style={{ marginTop: 6 }}>
                  The session reads the diff only (no checkout), then posts one review with inline comments on GitHub. It won't approve or request changes unless your instructions say so.
                </div>
              </>
            )}
          </>
        )}
        <div className="foot">
          <button className="btn" onClick={() => deck().openExternal(url)} disabled={!url}>
            Open on GitHub ↗
          </button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {reviewing ? 'Cancel' : 'Close'}
          </button>
          {!reviewing ? (
            <button className="btn primary" disabled={!pr} onClick={() => setReviewing(true)}>
              Review PR
            </button>
          ) : (
            <button className="btn primary" disabled={!pr} onClick={start} title="⌘↵">
              Start review
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function reviewSummary(reviews: PrSummary['reviews']): string {
  if (reviews.length === 0) return 'none yet'
  const count = (s: string) => reviews.filter((r) => r.state === s).length
  const parts = [
    count('APPROVED') && `${count('APPROVED')} approved`,
    count('CHANGES_REQUESTED') && `${count('CHANGES_REQUESTED')} changes requested`,
    count('COMMENTED') && `${count('COMMENTED')} commented`,
  ].filter(Boolean)
  return parts.join(', ') || 'none yet'
}
