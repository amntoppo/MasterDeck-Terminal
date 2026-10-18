import { memo, useState, type ReactNode } from 'react'
import { type AttentionAction, type AttentionItem, type AttentionList, type Tier } from '@shared/dashboard'
import { deck } from '../../deck'
import { ago, Skeleton } from './Card'
import { go, type DashNav } from './nav'

const TIER_LABEL: Record<Tier, string> = { now: 'Now', soon: 'Soon', ready: 'Ready', info: 'Info' }
const TIER_TIP: Record<Tier, string> = {
  now: 'Blocks a session or a PR until you act',
  soon: 'Wants you soon',
  ready: 'Ready for you, nothing is wrong',
  info: 'For your information',
}

/**
 * Inbox actions the row's button can run as they are: no text, choice or confirmation needed, and
 * nothing the renderer must open first. Every other kind is answered in the real Needs-you card
 * under the row (Reply…), so it acts exactly as in the Needs-you list.
 */
const DIRECT = new Set(['continue', 'compact', 'reload', 'loop-more', 'loop-continue', 'approve', 'send'])

const clock = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** Needs attention (#183): what needs the user, one row per subject, the most pressing first. */
export const AttentionCard = memo(function AttentionCard({
  list,
  now,
  loading,
  nav,
  replyId,
  reply,
  onReply,
  onDismiss,
  dismissedCount,
  onUndismiss,
}: {
  list: AttentionList
  now: number
  loading: boolean
  nav: DashNav
  /** The inbox item whose Needs-you card is open under its row. */
  replyId: string | null
  /** That card (DashboardView draws it: it needs the whole state). */
  reply: ReactNode
  onReply: (id: string | null) => void
  /** A derived item hidden on this device. */
  onDismiss: (item: AttentionItem) => void
  /** Derived items hidden on this device that are still present. */
  dismissedCount: number
  onUndismiss: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ id: string; text: string } | null>(null)

  const run = async (item: AttentionItem, a: AttentionAction) => {
    if (a.type === 'open') return go(nav, a.target ?? item.target)
    if (a.type === 'review' || a.type === 'merge') return 'pr' in item.target && nav.pr(item.target.pr, item.title)
    setBusy(item.id)
    setMsg(null)
    try {
      const r =
        a.type === 'inbox'
          ? await deck().inboxAct(item.inboxId ?? item.id, a.action)
          : a.type === 'retry' && item.scheduleId
            ? await deck().schedRunNow(item.scheduleId)
            : a.type === 'update'
              ? await deck().updateRestart()
              : { ok: true }
      if (!r.ok) setMsg({ id: item.id, text: ('message' in r && r.message) || 'That did not work.' })
    } catch (e) {
      setMsg({ id: item.id, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }
  const dismiss = (item: AttentionItem) => {
    if (item.inboxId) void deck().inboxAct(item.inboxId, 'dismiss')
    else onDismiss(item)
    if (replyId === item.id) onReply(null)
  }

  const count = list.total
  return (
    <section className="dash-card dash-attn" aria-label="Needs attention">
      <header className="dash-ch">
        <h3 className="dash-ct">Needs attention</h3>
        {!loading && list.now > 0 && (
          <span className="dash-pill dash-p-now" title="Items that block a session or a PR until you act">
            {list.now} now
          </span>
        )}
        {!loading && count > 0 && (
          <span className="dash-cnt" title="Every item here, Needs-you items and PRs alike">
            {count === 1 ? '1 thing needs you' : `${count} things need you`}
          </span>
        )}
        <span className="dash-grow" />
        <button className="dash-more" onClick={nav.needsYou}>
          Needs you →
        </button>
      </header>
      <div className="dash-cb">
        {loading ? (
          <Skeleton rows={3} />
        ) : !list.items.length ? (
          <div className="dash-allgood">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12l5 5 9-10" />
            </svg>
            Nothing needs you right now.
          </div>
        ) : (
          <div className="dash-arows">
            {list.items.map((item) => {
              const open = replyId === item.id
              const direct = item.actions.filter((a) => a.type !== 'inbox' || DIRECT.has(a.action))
              const answerHere = !!item.inboxId && item.actions.some((a) => a.type === 'inbox' && !DIRECT.has(a.action))
              return (
                <div key={item.id} className="dash-arow-wrap">
                  <div className="dash-arow">
                    <span className={`dash-pill dash-p-${item.tier}`} title={TIER_TIP[item.tier]}>
                      {TIER_LABEL[item.tier]}
                    </span>
                    <button className="dash-arow-main" onClick={() => go(nav, item.target)} title="Open">
                      <span className="dash-at">{item.title}</span>
                      {item.why && <span className="dash-aw">{item.why}</span>}
                    </button>
                    <span className="dash-age" title={`Since ${clock(item.at)}`}>
                      {ago(item.at, now)}
                    </span>
                    <span className="dash-acts">
                      {msg?.id === item.id && <span className="dash-err">{msg.text}</span>}
                      {direct.map((a) => (
                        <button key={`${a.type}:${a.label}`} className={`btn${a.primary ? ' primary' : ''}`} disabled={busy === item.id} onClick={() => void run(item, a)}>
                          {a.label}
                        </button>
                      ))}
                      {item.inboxId && (
                        <button className={`btn${open ? ' on' : ''}${answerHere && !direct.some((a) => a.primary) ? ' primary' : ''}`} aria-expanded={open} onClick={() => onReply(open ? null : item.id)}>
                          {open ? 'Close' : 'Reply…'}
                        </button>
                      )}
                    </span>
                    <button className="dash-x" aria-label="Dismiss" title={item.inboxId ? 'Dismiss (it comes back if the situation changes)' : 'Dismiss on this device (it comes back when it changes)'} onClick={() => dismiss(item)}>
                      ×
                    </button>
                  </div>
                  {open && <div className="dash-reply">{reply}</div>}
                </div>
              )
            })}
          </div>
        )}
        {!loading && (list.more > 0 || dismissedCount > 0) && (
          <div className="dash-foot">
            {list.more > 0 && (
              <button className="dash-more" onClick={nav.needsYou} title={`${list.more} more item${list.more === 1 ? '' : 's'} not shown here`}>
                and {list.more} more in Needs you →
              </button>
            )}
            {dismissedCount > 0 && (
              <span className="dash-sub">
                <span title="Dismissed here; they come back when they change">{dismissedCount} dismissed on this device</span> ·{' '}
                <button className="dash-more" onClick={onUndismiss}>
                  Show them again
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  )
})
