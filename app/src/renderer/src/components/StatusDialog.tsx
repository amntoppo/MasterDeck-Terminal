import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { attentionFor, MANUAL_STATUSES, sessionStatus, STATUS_TEXT, type StatusKey } from '@shared/review'
import type { AppState, Session } from '@shared/types'
import { deck } from '../deck'

/**
 * A session's status, set by hand: pick one (it stays until set back to Automatic), or stop the
 * session. Portalled to the end of the page so no window drag region covers it.
 */
export function StatusDialog({ session: s, state, onClose, onStopped }: { session: Session; state: AppState; onClose: () => void; onStopped?: () => void }) {
  const manual = state.manualStatus[s.key] ?? null
  const auto = sessionStatus(s, state.prStage[s.key], attentionFor(s, state.proposals))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = async (status: StatusKey | null) => {
    setBusy(true)
    const r = await deck().setManualStatus(s.key, status)
    setBusy(false)
    if (r.ok) onClose()
    else setMsg(r.message)
  }
  const stop = async () => {
    setBusy(true)
    setMsg(null)
    const r = s.kind === 'background' && s.bgId ? await deck().stopSession(s.bgId, s.name) : s.pid !== null ? await deck().stopOtherSession(s.pid, s.name) : { ok: false, message: 'no process to stop' }
    setBusy(false)
    if (r.message === 'cancelled') return
    if (!r.ok) return setMsg(r.message)
    onStopped?.()
    onClose()
  }
  const canStop = s.state !== 'done' && ((s.kind === 'background' && !!s.bgId) || s.pid !== null)

  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog status-dialog" role="dialog" aria-label={`Status of ${s.name}`}>
        <h3>
          Status · {s.name}
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </h3>
        <div className="meta">A status you set stays until you choose Automatic. Needs Input still shows while the session waits on a prompt.</div>
        <button className={`status-opt ${manual === null ? 'on' : ''}`} disabled={busy} onClick={() => void pick(null)}>
          <span className={`dot st-${auto.key}`} />
          <span className="grow">Automatic</span>
          <span className="muted">
            {auto.text}
            {auto.why ? ` · ${auto.why}` : ''}
          </span>
        </button>
        <div className="status-grid">
          {MANUAL_STATUSES.map((k) => (
            <button key={k} className={`status-opt ${manual === k ? 'on' : ''}`} disabled={busy} onClick={() => void pick(k)}>
              <span className={`dot st-${k}`} />
              {STATUS_TEXT[k]}
            </button>
          ))}
        </div>
        {msg && <div className="meta bad">{msg}</div>}
        <div className="foot">
          {canStop && (
            <button className="btn danger" disabled={busy} onClick={() => void stop()} title="End the session (its conversation is kept and can be resumed); it leaves the sessions list">
              Stop session…
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
