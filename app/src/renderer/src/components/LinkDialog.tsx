import { useEffect, useRef, useState } from 'react'
import { resolveSession, suggestSessions } from '@shared/link'
import { formatAgo } from '@shared/format'
import type { AppState, Issue, Session } from '@shared/types'
import { deck, useNow } from '../deck'

interface Props {
  issue: Issue
  state: AppState
  onClose: () => void
  /** Linked: the session to open, when `claude agents` lists it. */
  onLinked: (session: Session | null) => void
}

export function LinkDialog({ issue, state, onClose, onLinked }: Props) {
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

  const resolved = resolveSession(text, state.sessions)
  const suggestions = suggestSessions(text, state.sessions)

  const submit = async () => {
    if (busy) return
    const sessionId = resolved.kind === 'session' ? resolved.session.sessionId : resolved.kind === 'id' ? resolved.sessionId : null
    if (!sessionId) return
    setBusy(true)
    setError(null)
    const cwd = resolved.kind === 'session' ? (state.stats[resolved.session.sessionId]?.currentDir ?? resolved.session.cwd) : null
    const r = await deck().linkSession(issue.number, sessionId, cwd)
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    onLinked(resolved.kind === 'session' ? resolved.session : null)
    onClose()
  }

  const hint =
    resolved.kind === 'session'
      ? `→ ${resolved.session.name} (${resolved.session.sessionId.slice(0, 8)})${resolved.session.issue !== null && resolved.session.issue !== issue.number ? ` · now linked to #${resolved.session.issue}; this moves it to #${issue.number}` : ''}`
      : resolved.kind === 'id'
        ? '→ a session not running right now; linked by id'
        : resolved.kind === 'ambiguous'
          ? `${resolved.matches.length} sessions match; pick one below or type more`
          : text.trim()
            ? 'No session matches'
            : ''

  return (
    <div className="backdrop" style={{ zIndex: 55 }} onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-label={`Link a session to #${issue.number}`} style={{ borderTopColor: 'var(--accent)' }}>
        <h3>
          <span className="kind" style={{ ['--kind' as string]: 'var(--accent)' }}>
            LINK
          </span>
          #{issue.number} {issue.title}
        </h3>
        <div className="meta">Link a session that already exists to this ticket, as babysit-ticket does. The ticket moves to In Dev if it is earlier on the board.</div>
        <label>Session ID or name</label>
        <input
          ref={inputRef}
          value={text}
          placeholder="e.g. 1036-notification-pop-up, 9338a616, or a full session id"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <div className={`meta ${resolved.kind === 'none' && text.trim() ? 'error' : ''}`} style={{ marginTop: 4, minHeight: 16 }}>
          {hint}
        </div>
        {suggestions.length > 0 && (
          <div className="suggest">
            {suggestions.map((s) => (
              <div
                key={s.key}
                className={`row ${resolved.kind === 'session' && resolved.session.key === s.key ? 'active' : ''}`}
                onClick={() => setText(s.sessionId)}
                title={s.sessionId}
              >
                <span className={`dot ${s.state}`} />
                <span className="label">{s.name}</span>
                {s.issue !== null && <span className="num">#{s.issue}</span>}
                <span className="sub mono">{s.sessionId.slice(0, 8)}</span>
                <span className="sub">{s.startedAt ? formatAgo(now - s.startedAt) : ''}</span>
              </div>
            ))}
          </div>
        )}
        <div className="foot">
          <span className="grow">{error && <span className="error">{error}</span>}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || (resolved.kind !== 'session' && resolved.kind !== 'id')}>
            {busy ? 'Linking…' : 'Link'}
          </button>
        </div>
      </div>
    </div>
  )
}
