import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Phone only (Board and PRs): the filter row folds into a "Filters (n)" button next to the search
 * box; the button opens the view's own filter controls (`children`) in a sheet. n counts the
 * active filters other than search.
 */
export function PhoneFilters({ count, search, onReset, children }: { count: number; search: ReactNode; onReset: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <div className="filter-bar phone-filters">
      <button className={`btn ${count ? 'active' : ''}`} onClick={() => setOpen(true)}>
        Filters ({count})
      </button>
      {search}
      {open &&
        createPortal(
          <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
            <div className="dialog filters-sheet" role="dialog" aria-label="Filters">
              <h3>
                Filters
                <span style={{ flex: 1 }} />
                <button className="icon-btn" onClick={() => setOpen(false)} title="Close (Esc)">
                  ×
                </button>
              </h3>
              <div className="filters-sheet-body">{children}</div>
              <div className="foot">
                <button className="btn" onClick={onReset} disabled={!count}>
                  Reset
                </button>
                <span className="grow" />
                <button className="btn primary" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
