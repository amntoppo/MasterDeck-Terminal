import { useEffect } from 'react'
import type { Session } from '@shared/types'

interface Props {
  session: Session
  /** master-agent: only "stop the other one" is offered; two masters block every CLI write. */
  isMaster: boolean
  onClose: () => void
  onStart: (stopOther: boolean) => void
}

export function StartHereDialog({ session: s, isMaster, onClose, onStart }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const go = (stopOther: boolean) => {
    onStart(stopOther)
    onClose()
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={`Start ${s.name} here`} style={{ borderTopColor: 'var(--accent)' }}>
        <h3>Start {s.name} here</h3>
        <p>
          {s.name} is still open in another terminal (pid {s.pid}). Starting it here resumes the same conversation as a background
          session and attaches it in this tab.
        </p>
        {isMaster ? (
          <p className="meta">The other master-agent is stopped first: two master-agents would make the master CLI refuse every write.</p>
        ) : (
          <p className="meta">
            <b>Stop the other one</b> ends the copy in the other terminal first (its conversation is kept). <b>Start here anyway</b> leaves it
            running, so two copies of the conversation are live at once.
          </p>
        )}
        <div className="foot">
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {!isMaster && (
            <button className="btn" onClick={() => go(false)}>
              Start here anyway
            </button>
          )}
          <button className="btn primary" onClick={() => go(true)}>
            Stop the other one and start here
          </button>
        </div>
      </div>
    </div>
  )
}
