import { useEffect, useState } from 'react'
import type { AppState, BoardCard } from '@shared/types'
import { deck } from '../deck'

interface Props {
  card: BoardCard
  state: AppState
  onClose: () => void
  /** Assigned: to me opens the Start dialog; to someone else just confirms. */
  onAssigned: (card: BoardCard, login: string) => void
}

export function AssignPopup({ card, state, onClose, onAssigned }: Props) {
  const me = state.me
  const others = state.users.filter((u) => u !== me).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const [login, setLogin] = useState(me ?? others[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const assign = async () => {
    if (!login) return
    setBusy(true)
    setError(null)
    const r = await deck().assignIssue(card.number, login, card.assignees)
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    onAssigned(card, login)
    onClose()
  }

  const change = card.assignees.length ? `Replaces ${card.assignees.join(', ')}.` : 'Nobody is assigned yet.'
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-label={`Assign #${card.number}`} style={{ borderTopColor: 'var(--amber)' }}>
        <h3>
          <span className="kind" style={{ ['--kind' as string]: 'var(--amber)' }}>
            ASSIGN
          </span>
          #{card.number} {card.title}
        </h3>
        <div className="meta">
          {card.status ?? 'No status'} · no PR yet ·{' '}
          <button className="link-btn" onClick={() => deck().openExternal(card.url)}>
            open on GitHub ↗
          </button>
        </div>
        <label>Assign it</label>
        <select className="fsel full" value={login} onChange={(e) => setLogin(e.target.value)} disabled={busy}>
          {me && <option value={me}>Me ({me})</option>}
          {others.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <div className="meta" style={{ marginTop: 6 }}>
          {change} {login === me ? 'Then the Start dialog opens so you can start a session for it.' : ''}
        </div>
        <div className="foot">
          <span className="grow">{error && <span className="error">{error}</span>}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={assign} disabled={busy || !login || (card.assignees.length === 1 && card.assignees[0] === login)}>
            {busy ? 'Assigning…' : login === me ? 'Assign to me' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  )
}
