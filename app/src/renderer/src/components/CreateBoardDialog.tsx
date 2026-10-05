import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BOARD_ADD_MAX, cleanTitle, planTotal, titleTaken, type BoardCreateResult, type BoardPlanResult, type BoardProgress } from '@shared/boardCreate'
import { DERIVED_COLUMNS } from '@shared/derivedBoard'
import { deck } from '../deck'

/** The commands of a fix, for a terminal on the Mac: MasterDeck never changes gh's active account itself. */
function Fix({ lines }: { lines: string[] }) {
  return (
    <>
      <div className="muted small">Run this in a terminal, then press Refresh in MasterDeck:</div>
      <pre>{lines.join('\n')}</pre>
      <button className="btn" onClick={() => deck().copy(lines.join('\n'))}>
        Copy
      </button>
    </>
  )
}

function Link({ url }: { url: string }) {
  return (
    <a href={url} onClick={(e) => (e.preventDefault(), void deck().openExternal(url))}>
      {url}
    </a>
  )
}

/**
 * Create a GitHub board for an account that has none (the Board's hint, desktop only): name it,
 * see what will be made, then main asks once more on the Mac and does it as that account.
 */
export function CreateBoardDialog({ account, onClose }: { account: string | null; onClose: () => void }) {
  const [plan, setPlan] = useState<BoardPlanResult | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BoardProgress | null>(null)
  const [result, setResult] = useState<BoardCreateResult | null>(null)
  /** Why a Try again did not run (the earlier result stays on screen). */
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Another account: nothing of the one before stays on screen (its plan, its name, its result).
    setPlan(null)
    setTitle('')
    setResult(null)
    setNote(null)
    setProgress(null)
    void deck()
      .boardCreatePlan(account ?? undefined)
      .then((p) => {
        if (!alive) return
        setPlan(p)
        if (p.ok) setTitle(p.title)
      })
      // A call that never reaches main must not leave "Checking GitHub…" up for good.
      .catch(() => alive && setPlan({ ok: false, message: 'MasterDeck could not check GitHub. Close this and try again.' }))
    return () => {
      alive = false
    }
  }, [account])
  useEffect(() => deck().onBoardCreateProgress(setProgress), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const run = async (go: () => Promise<BoardCreateResult>) => {
    setBusy(true)
    setNote(null)
    let r: BoardCreateResult
    try {
      r = await go()
    } catch {
      // The call itself failed (main is gone, the channel broke): what GitHub got is not known.
      r = { ok: false, message: `MasterDeck lost track of this run. Check ${plan?.ok ? `${plan.owner}'s` : 'your'} projects on GitHub before trying again.` }
    } finally {
      // Whatever happened, the dialog can be used and closed again.
      setBusy(false)
      setProgress(null)
    }
    // Cancelled in the Mac's confirmation: back to the form, nothing to report.
    if (!r.ok && r.message === 'cancelled') return
    // A board was made already: a Try again that could not run does not replace that result.
    if (!r.ok && !r.retry && (result?.ok || (result && !result.ok && result.retry))) return setNote(r.message)
    setResult(r)
  }
  const name = cleanTitle(title)
  const taken = plan?.ok && name ? titleTaken(plan.existing, name) : null
  const canCreate = !!name && !taken && !busy
  const create = () => run(() => deck().boardCreate({ account: account ?? undefined, title: name ?? '' }))
  const again = () => void run(() => deck().boardCreateRetry(account ?? undefined))
  const total = plan?.ok ? planTotal(plan) : 0
  /** The board exists but the run did not finish it: Try again does, a second Create would not. */
  const unfinished = result && !result.ok && result.retry ? result : null

  return createPortal(
    <div className="backdrop" style={{ zIndex: 55 }} onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog create-board" role="dialog" aria-label="Create a GitHub board">
        <h3>
          Create a GitHub board
          {account && <span className="muted small"> as @{account}</span>}
        </h3>
        {!plan ? (
          <div className="muted">Checking GitHub…</div>
        ) : !plan.ok ? (
          <>
            <div className="error">{plan.message}</div>
            {plan.fix && <Fix lines={plan.fix} />}
            <div className="form-buttons">
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : unfinished ? (
          <>
            <div className="error">{unfinished.message}</div>
            {unfinished.url && <Link url={unfinished.url} />}
            {(unfinished.failed?.length ?? 0) > 0 && <div className="error">GitHub refused {unfinished.failed?.join(', ')}.</div>}
            {(unfinished.left ?? 0) > 0 && <div className="error">{unfinished.left} not added yet: GitHub stopped answering (usually a rate limit).</div>}
            {note && <div className="error">{note}</div>}
            {busy && <div className="muted">{progress ? progress.text : 'Working…'}</div>}
            <div className="form-buttons">
              <button className="btn" disabled={busy} onClick={onClose}>
                Close
              </button>
              <button className="btn primary" disabled={busy} onClick={again}>
                {busy ? 'Working…' : 'Try again'}
              </button>
            </div>
          </>
        ) : result?.ok ? (
          <>
            <div className="wf-ok">✓ {result.message}</div>
            {result.url && <Link url={result.url} />}
            {result.failed.length > 0 && <div className="error">GitHub refused {result.failed.join(', ')}.</div>}
            {result.left > 0 && <div className="error">{result.left} not added yet: GitHub stopped answering (usually a rate limit). Try again in a few minutes.</div>}
            {result.unset > 0 && <div className="muted small">{result.unset} added without a column: they sit in “No status” on the board.</div>}
            {result.warnings.map((w) => (
              <div key={w} className="muted small">
                {w}
              </div>
            ))}
            {note && <div className="error">{note}</div>}
            {busy && <div className="muted">{progress ? progress.text : 'Adding…'}</div>}
            <div className="form-buttons">
              {(result.failed.length > 0 || result.left > 0 || result.unread.length > 0) && (
                <button className="btn" disabled={busy} onClick={again}>
                  {busy ? 'Adding…' : 'Try again'}
                </button>
              )}
              <button className="btn primary" disabled={busy} onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="meta">
              A GitHub project under <b>{plan.owner}</b> with the columns {DERIVED_COLUMNS.join(', ')}, linked to {plan.repos.length === 1 ? 'this repository' : 'these repositories'} and filled
              with {total === null ? `an unknown number of (${BOARD_ADD_MAX} at most)` : total > BOARD_ADD_MAX ? `the first ${BOARD_ADD_MAX} of ${total}` : total} open {total === 1 ? 'issue' : 'issues'}. This tab
              then shows that board.
            </div>
            <label>Name</label>
            <input autoFocus value={title} maxLength={100} disabled={busy} spellCheck={false} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && canCreate && void create()} />
            <ul>
              {plan.repos.map((r) => (
                <li key={r.repo}>
                  {r.repo} · {r.open ?? 'an unknown number'} open
                </li>
              ))}
              {plan.missing.map((r) => (
                <li key={r} className="muted">
                  {r} · left out: GitHub did not answer for it
                </li>
              ))}
              {plan.skipped.map((r) => (
                <li key={r} className="muted">
                  {r} · left out: more than 10 repositories
                </li>
              ))}
            </ul>
            {taken && (
              <div className="error">
                {plan.owner} already has a board named “{taken.title}”. Pick it in Setup → Repos & boards, or choose another name.
              </div>
            )}
            {result && !result.ok && (
              <>
                <div className="error">{result.message}</div>
                {result.url && <Link url={result.url} />}
                {result.fix && <Fix lines={result.fix} />}
              </>
            )}
            {busy && <div className="muted">{progress ? progress.text : 'Confirm on your Mac…'}</div>}
            <div className="form-buttons">
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" disabled={!canCreate} onClick={() => void create()}>
                {busy ? 'Creating…' : 'Create board…'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
