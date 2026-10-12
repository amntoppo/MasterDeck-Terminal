import { useEffect, useState } from 'react'
import { assignChoices, assignSeed, startSessionTitle } from '@shared/boardFilter'
import { fullRepo, ticketLabel, ticketOf } from '@shared/ticket'
import type { AppState, BoardCard } from '@shared/types'
import { deck } from '../deck'
import { MarkdownView } from './MarkdownView'
import { SubIssues } from './SubIssues'

interface Props {
  card: BoardCard
  state: AppState
  onClose: () => void
  /** Assigned: to me opens the Start dialog; to someone else just confirms. */
  onAssigned: (card: BoardCard, login: string) => void
  /** Start a session for it as it is, without assigning it (nothing is written to GitHub). */
  onStart: (card: BoardCard) => void
  /** "Me" on the Board tab it was clicked in: the tab's account with two or more; absent: the primary's login. */
  me?: string | null
}

export function AssignPopup({ card, state, onClose, onAssigned, onStart, me: tabMe }: Props) {
  const me = tabMe === undefined ? state.me : tabMe
  // The people who can be assigned in the card's repository. The primary issue repo's are in the
  // state already; any other repository's are read now, as that repository's account (kept an hour
  // in main). Until they arrive, and if the read fails, "Me" alone is offered.
  const [people, setPeople] = useState<string[] | null>(() => assignSeed(card.repo, state))
  const [peopleError, setPeopleError] = useState<string | null>(null)
  const others = assignChoices(me, people ?? []).filter((u) => u.toLowerCase() !== me?.toLowerCase())
  const [login, setLogin] = useState(me ?? others[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The ticket's GitHub description, so what the work is shows before it is picked up: null while loading.
  const [desc, setDesc] = useState<string | null>(null)
  const [descError, setDescError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.resolve(deck().issueBody(ticketOf(card))).then(
      (r) => {
        if (!alive) return
        setDesc(r.ok ? r.body : '')
        if (!r.ok) setDescError(r.message)
      },
      (e) => {
        if (!alive) return
        setDesc('')
        setDescError(String(e))
      },
    )
    return () => {
      alive = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (people) return
    let open = true
    const failed = (message: string) => {
      setPeople([])
      setPeopleError(message)
    }
    Promise.resolve(deck().assignableUsers(card.repo ?? null)).then(
      (r) => {
        if (!open) return
        if (!r.ok) return failed(r.message)
        setPeople(r.users)
        // Nobody to preselect yet (no login of mine is known): the first of the people read.
        setLogin((l) => l || assignChoices(me, r.users)[0] || '')
      },
      (e) => open && failed(String(e)),
    )
    return () => {
      open = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const assign = async () => {
    if (!login) return
    setBusy(true)
    setError(null)
    const r = await deck().assignIssue(ticketOf(card), login, card.assignees)
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
      <div className="dialog" role="dialog" aria-label={`Assign ${ticketLabel(card.repo, card.number)}`} style={{ borderTopColor: 'var(--amber)' }}>
        <h3>
          <span className="kind" style={{ ['--kind' as string]: 'var(--amber)' }}>
            ASSIGN
          </span>
          {ticketLabel(card.repo, card.number)} {card.title}
        </h3>
        <div className="meta">
          {card.status ?? 'No status'} · no PR yet ·{' '}
          <button className="link-btn" onClick={() => deck().openExternal(card.url)}>
            open on GitHub ↗
          </button>
        </div>
        <label>Description</label>
        {desc === null ? (
          <div className="meta">Loading the description from GitHub…</div>
        ) : (
          <div className="desc-preview popup-desc" tabIndex={0} aria-label="Ticket description, rendered">
            {desc.trim() ? (
              <MarkdownView text={desc} />
            ) : (
              <span className="muted">{descError ? `Could not load the description: ${descError}` : 'This ticket has no description.'}</span>
            )}
          </div>
        )}
        <SubIssues ticket={ticketOf(card)} state={state} />
        <label>Assign it</label>
        <select className="fsel full" value={login} onChange={(e) => setLogin(e.target.value)} disabled={busy}>
          {me && <option value={me}>Me ({me})</option>}
          {others.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        {people === null && (
          <div className="meta" style={{ marginTop: 6 }}>
            Loading who else can be assigned in {fullRepo(card.repo).split('/')[1] ?? fullRepo(card.repo)}…
          </div>
        )}
        {peopleError && (
          <div className="error" style={{ marginTop: 6 }}>
            {peopleError} {me ? 'You can still assign it to yourself.' : ''}
          </div>
        )}
        <div className="meta" style={{ marginTop: 6 }}>
          {change} {login === me ? 'Then the Start dialog opens so you can start a session for it.' : ''}
        </div>
        <div className="foot">
          <span className="grow">{error && <span className="error">{error}</span>}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy}
            title={startSessionTitle(card.assignees)}
            onClick={() => {
              onStart(card)
              onClose()
            }}
          >
            Start a session
          </button>
          <button className="btn primary" onClick={assign} disabled={busy || !login || (card.assignees.length === 1 && card.assignees[0] === login)}>
            {busy ? 'Assigning…' : login === me ? 'Assign to me' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  )
}
