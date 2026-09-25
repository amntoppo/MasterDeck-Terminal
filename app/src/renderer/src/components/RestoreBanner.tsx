import { useState } from 'react'
import type { AppState } from '@shared/types'
import { deck } from '../deck'

/** "N sessions stopped when the Mac restarted": resume them all, or dismiss the list. */
export function RestoreBanner({ state }: { state: AppState }) {
  const [msg, setMsg] = useState<string | null>(null)
  const stopped = state.stoppedByRestart
  if (!stopped.length && !msg) return null
  if (!stopped.length)
    return (
      <div className="banner restore" onClick={() => setMsg(null)}>
        {msg}
      </div>
    )
  const names = stopped.map((e) => (e.issue ? `#${e.issue} ${e.name}` : e.name))
  return (
    <div className="banner restore">
      <span className="grow">
        <b>
          {stopped.length} session{stopped.length === 1 ? '' : 's'} stopped when the Mac restarted
        </b>
        <span className="muted" title={names.join('\n')}>
          {' '}
          · {names.slice(0, 3).join(', ')}
          {names.length > 3 ? ` and ${names.length - 3} more` : ''}
        </span>
        {msg && <span className="muted"> · {msg}</span>}
      </span>
      <button
        className="btn primary"
        disabled={state.restoring}
        title="claude --bg --resume each one: same conversation, same id, in its folder"
        onClick={async () => setMsg((await deck().resumeStopped()).message)}
      >
        {state.restoring ? 'Resuming…' : 'Resume all'}
      </button>
      <button className="btn" disabled={state.restoring} onClick={() => void deck().dismissStopped()} title="Forget them; History can still resume each one">
        Dismiss
      </button>
    </div>
  )
}
