import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { deck } from '../deck'
import { filterRepos, type Repo } from '../repoPicker'

/**
 * The web app's folder picker (the native one cannot open from a browser): the workspace repos, a filter, and a
 * typed path. The Mac validates whatever path comes back. `onDone(null)` on cancel.
 */
export function RepoPicker({ start, onDone }: { start?: string; onDone: (path: string | null) => void }) {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [q, setQ] = useState('')
  const [path, setPath] = useState(start ?? '')
  useEffect(() => {
    void deck()
      .workspaceRepos()
      .then(setRepos, () => setRepos([]))
  }, [])
  useEffect(() => {
    // Capture + stop: Escape closes only the picker, not the dialog under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onDone(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDone])
  const shown = repos ? filterRepos(repos, q) : []
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <div className="dialog status-dialog" role="dialog" aria-modal="true" aria-labelledby="rp-title">
        <h3 id="rp-title">Choose a folder on your Mac</h3>
        <input value={q} placeholder="Filter repos…" aria-label="Filter repos" onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="wt-list" style={{ maxHeight: 280, overflow: 'auto' }}>
          {repos === null && <div className="meta">Loading repos…</div>}
          {repos && !shown.length && <div className="meta">No repos match.</div>}
          {shown.map((r) => (
            <button key={r.path} className="mpick-row" style={{ width: '100%', textAlign: 'left' }} onClick={() => onDone(r.path)} title={r.path}>
              <b>{r.name}</b> <span className="muted mono">{r.path}</span>
            </button>
          ))}
        </div>
        <label>Or type a path</label>
        <div className="row-inputs">
          <input value={path} placeholder="~/code/my-repo" aria-label="Folder path" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && onDone(path.trim())} />
          <button className="btn primary" disabled={!path.trim()} onClick={() => onDone(path.trim())}>
            Use this path
          </button>
        </div>
        <div className="foot">
          <span className="grow" />
          <button className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
