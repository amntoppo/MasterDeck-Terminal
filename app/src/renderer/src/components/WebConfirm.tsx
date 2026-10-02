import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { onConfirmRequest, type ConfirmRequest } from '../webConfirm'

/**
 * The web app's confirm (the Mac's native dialogs do not run for web calls): one request at a time, Cancel
 * focused, Escape and backdrop clicks cancel. Mounted once in App.
 */
export function WebConfirm() {
  const [r, setR] = useState<ConfirmRequest | null>(null)
  useEffect(() => onConfirmRequest(setR), [])
  useEffect(() => {
    if (!r) return
    // Capture + stop: Escape cancels only the confirm, not the dialog under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      r.resolve(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [r])
  if (!r) return null
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && r.resolve(false)}>
      <div className="dialog status-dialog" role="dialog" aria-modal="true" aria-labelledby="wc-title" key={r.id}>
        <h3 id="wc-title">{r.message}</h3>
        <div className="foot">
          <span className="grow" />
          <button className="btn" autoFocus onClick={() => r.resolve(false)}>
            Cancel
          </button>
          <button className={`btn ${r.danger ? 'danger' : 'primary'}`} onClick={() => r.resolve(true)}>
            {r.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
