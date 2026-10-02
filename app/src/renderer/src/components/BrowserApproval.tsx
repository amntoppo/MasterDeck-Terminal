import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppState } from '@shared/types'
import { deck, useNow } from '../deck'
import { allowArmed, nextRequest } from './nextBrowserRequest'

/**
 * A browser asks to control this Mac: compare the three words, then Allow or Deny. Escape and
 * backdrop clicks do nothing; the request stays until decided or expired. Deny has the focus.
 */
export function BrowserApproval({ state }: { state: AppState }) {
  const now = useNow(200)
  const r = nextRequest(state.browserRequests, now)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState({ id: '', at: 0 })
  useEffect(() => {
    setBusy(false)
    if (r) setShown({ id: r.id, at: Date.now() })
  }, [r?.id])
  if (!r) return null
  const pending = (state.browserRequests ?? []).filter((x) => x.expiresAt > now).length
  const armed = shown.id === r.id && allowArmed(shown.at, now)
  const decide = async (allow: boolean) => {
    setBusy(true)
    try {
      await deck().browserDecide(r.id, allow)
    } finally {
      setBusy(false)
    }
  }
  return createPortal(
    <div className="backdrop">
      <div className="dialog status-dialog" role="dialog" aria-modal="true" aria-labelledby="ba-title" key={r.id}>
        <h3 id="ba-title">Allow {r.name} to control this Mac?</h3>
        <div className="meta">
          {r.email} · signed in on the web{pending > 1 ? ` · 1 of ${pending}` : ''}
        </div>
        <div className="meta">Your browser should show:</div>
        <p className="ba-words">{r.words.join(' · ')}</p>
        <div className="meta">Only allow if your browser shows the same three words. It will be able to do anything MasterDeck can do here, including typing into terminals.</div>
        <div className="foot">
          <span className="grow" />
          <button className="btn" autoFocus disabled={busy} onClick={() => void decide(false)}>
            Deny
          </button>
          <button className="btn primary" disabled={busy || !armed} onClick={() => void decide(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
