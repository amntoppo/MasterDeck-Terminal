import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { autoStatusLine, STATUS_TEXT } from '@shared/autoReview'
import type { PrFilters } from '@shared/teamPrs'
import type { AppState } from '@shared/types'
import type { WatchEvent } from '@shared/watches'
import { deck, useNow } from '../deck'
import { formatAgo } from '@shared/format'

interface Props {
  state: AppState
  tabId: string
  tab: { name: string; filters: PrFilters }
  /** The tab's account (two or more accounts). */
  account?: string
  /** Beside the chat's input box (its place, from the panel), or in the flow (a phone). */
  style?: CSSProperties
  inline?: boolean
}

/** What turning Merge automatically on means; the user confirms it first. */
const MERGE_WARNING = [
  'MasterDeck will merge, as this tab’s GitHub account, every PR it reviewed for this tab once GitHub says it is ready: approved, every check green, no conflicts, not a draft, branch protection satisfied, and no commits since the review.',
  'It merges without anyone looking again, with the repository’s default merge method (merge, squash or rebase), and a merge cannot easily be undone.',
  'It never merges a PR with a failing, pending or blocked check, and never bypasses branch protection. Each merge is told in Needs you.',
]

/**
 * Review with Claude's automation (#157): Automate Review and Merge automatically for the PR tab,
 * a status line, and (opened) the MasterDeck monitor behind it and the PRs it follows.
 */
export function AutoReviewWidget({ state, tabId, tab, account, style, inline }: Props) {
  const now = useNow(15_000)
  const view = state.autoReview
  const t = view?.tabs[tabId]
  const prs = (view?.prs ?? []).filter((p) => p.tabId === tabId)
  const review = !!t?.review
  const merge = !!t?.merge
  const [msg, setMsg] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [open, setOpen] = useState(false)
  const set = async (r: boolean, m: boolean) => {
    const res = await deck().autoReviewSet(tabId, { review: r, merge: r && m, name: tab.name, ...(account ? { account } : {}), filters: tab.filters })
    setMsg(res.ok ? null : res.message)
  }
  return (
    <div className={`auto-widget${inline ? ' inline' : ''}`} style={style} aria-label="Automation">
      <div className="auto-row">
        <label className="auto-sw" title="Review every PR whose review is asked of you, and post the comments">
          <button className={`switch ${review ? 'on' : ''}`} role="switch" aria-checked={review} aria-label="Automate Review" onClick={() => void set(!review, false)} />
          Automate Review
        </label>
        <label className="auto-sw" title={review ? 'Merge PRs it reviewed once they are ready' : 'Turn on Automate Review first'}>
          <button
            className={`switch ${merge ? 'on' : ''}`}
            role="switch"
            aria-checked={merge}
            aria-label="Merge automatically"
            disabled={!review}
            onClick={() => (merge ? void set(true, false) : setAsking(true))}
          />
          Merge automatically
        </label>
        <button className="link-btn auto-more-btn" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide the details' : 'The monitor and the PRs it follows'}>
          {open ? '▾' : '▴'}
        </button>
      </div>
      <div className={`auto-status small ${msg || t?.error ? 'bad' : 'muted'}`} title={msg ?? t?.error ?? undefined}>
        {msg ?? autoStatusLine(t, prs, tabId, now)}
      </div>
      {open && (
        <div className="auto-more">
          {review ? <MonitorRow id={`review:${tabId}`} state={state} now={now} /> : <div className="muted small">No monitor: Automate Review is off.</div>}
          {prs.length > 0 && (
            <ul className="auto-prs">
              {prs.map((p) => (
                <li key={p.url}>
                  <button className="link-btn" onClick={() => deck().openExternal(p.reviewUrl ?? p.url)} title={p.title}>
                    {p.repo}#{p.number}
                  </button>{' '}
                  <span className={`auto-st st-${p.status}`}>{STATUS_TEXT[p.status]}</span>
                  {p.status === 'commented' && p.comments > 0 && <span className="muted"> · {p.comments} comments</span>}
                  {p.note && <span className="muted"> · {p.note}</span>}
                  <span className="muted"> · {formatAgo(now - p.at)} ago</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {asking &&
        createPortal(
        <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAsking(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Merge automatically" style={{ borderTopColor: 'var(--red)' }}>
            <h3>Merge automatically?</h3>
            {MERGE_WARNING.map((p) => (
              <p key={p}>{p}</p>
            ))}
            <div className="foot">
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => setAsking(false)} autoFocus>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  setAsking(false)
                  void set(true, true)
                }}
              >
                Turn on Merge automatically
              </button>
            </div>
          </div>
        </div>,
          // Above the panel and its split line: the widget's own stacking would cut it off.
          document.body,
        )}
    </div>
  )
}

/** The MasterDeck monitor behind Automate Review, as Details lists monitors: by MasterDeck, its events, Stop. */
function MonitorRow({ id, state, now }: { id: string; state: AppState; now: number }) {
  const w = state.watches.find((x) => x.id === id)
  const [events, setEvents] = useState<WatchEvent[]>([])
  useEffect(() => {
    let alive = true
    Promise.resolve(deck().watchEvents(id)).then(
      (r) => alive && setEvents(Array.isArray(r) ? r.slice(0, 20) : []),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [id, w?.events, w?.lastEventAt])
  if (!w) return null
  return (
    <div className="auto-monitor">
      <div className="auto-mon-head">
        <span className="mon-dot" aria-hidden="true" />
        <b title={w.command}>{w.description}</b>
        <span className="muted small"> · by MasterDeck · {w.events} event{w.events === 1 ? '' : 's'}</span>
        <span style={{ flex: 1 }} />
        <button className="link-btn gh-stop" onClick={() => void deck().watchStop(id)} title="Stop it (turns Automate Review off)">
          Stop
        </button>
      </div>
      {events.map((e, i) => (
        <div key={`${e.at}-${i}`} className="auto-event small">
          <span className="muted">{formatAgo(now - e.at)} ago</span> {e.text}
        </div>
      ))}
    </div>
  )
}
