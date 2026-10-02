import { createPortal } from 'react-dom'
import type { AppState } from '@shared/types'
import { deck, useNow } from '../deck'
import { nextRequest } from './nextBrowserRequest'

/**
 * A browser asks to control this Mac: compare the three words, then Allow or Deny. Escape and
 * backdrop clicks do nothing; the request stays until decided or expired. Deny has the focus.
 */
export function BrowserApproval({ state }: { state: AppState }) {
  const now = useNow(1000)
  const r = nextRequest(state.browserRequests, now)
  if (!r) return null
  return createPortal(
    <div className="backdrop">
      <div className="dialog status-dialog" role="dialog" aria-modal="true" aria-labelledby="ba-title" key={r.id}>
        <h3 id="ba-title">Allow {r.name} to control this Mac?</h3>
        <div className="meta">{r.email} · signed in on the web</div>
        <p className="ba-words" aria-label="Check these words match your browser">
          {r.words.join(' · ')}
        </p>
        <div className="meta">Only allow if your browser shows the same three words. It will be able to do anything MasterDeck can do here, including typing into terminals.</div>
        <div className="foot">
          <span className="grow" />
          <button className="btn" autoFocus onClick={() => void deck().browserDecide(r.id, false)}>
            Deny
          </button>
          <button className="btn primary" onClick={() => void deck().browserDecide(r.id, true)}>
            Allow
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
