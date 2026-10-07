import { useEffect, useRef, useState } from 'react'
import { ticketLabel } from '@shared/ticket'
import { formatAgo } from '@shared/format'
import type { AppState, Session } from '@shared/types'
import { deck, useNow } from '../deck'
import { linkable } from './peersView'

interface Props {
  state: AppState
  session: Session
  onClose: () => void
}

/** Pick a running session to link to this one; each pick links at once and the list stays open. */
export function PeersDialog({ state, session, onClose }: Props) {
  const now = useNow(15_000)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const suggestions = linkable(state, session.key, text)

  const pick = async (peer: Session) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await deck().peersSet(session.key, peer.key, true)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  return (
    <div className="backdrop" style={{ zIndex: 55 }} onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-label={`Link sessions to ${session.name}`} style={{ borderTopColor: 'var(--accent)' }}>
        <h3>
          <span className="kind" style={{ ['--kind' as string]: 'var(--accent)' }}>
            LINK
          </span>
          Link sessions
        </h3>
        <div className="meta">Linked sessions see each other's summary.</div>
        <label>Session name</label>
        <input ref={inputRef} value={text} placeholder="Filter by name or session id" spellCheck={false} onChange={(e) => setText(e.target.value)} />
        {suggestions.length > 0 ? (
          <div className="suggest">
            {suggestions.map((s) => (
              <div key={s.key} className="row" onClick={() => void pick(s)} title={s.sessionId}>
                <span className={`dot ${s.state}`} />
                <span className="label">{s.name}</span>
                {s.issue !== null && <span className="num">{ticketLabel(s.issueRepo, s.issue)}</span>}
                <span className="sub mono">{s.sessionId.slice(0, 8)}</span>
                <span className="sub">{s.startedAt ? formatAgo(now - s.startedAt) : ''}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="meta" style={{ marginTop: 8 }}>
            {text.trim() ? 'No session matches' : 'No other sessions to link'}
          </div>
        )}
        <div className="foot">
          <span className="grow">{error && <span className="error">{error}</span>}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
