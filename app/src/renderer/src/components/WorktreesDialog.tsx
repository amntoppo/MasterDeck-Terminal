import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionWorktree } from '@shared/worktrees'
import type { Session } from '@shared/types'
import { deck } from '../deck'
import { can } from '../web'

/**
 * The git worktrees a session created or worked in (any repo), each with Open in editor (the
 * default IDE). A session without one shows the folder it works in instead.
 */
export function WorktreesDialog({ session: s, worktrees, dir, onClose }: { session: Session; worktrees: SessionWorktree[]; dir: string; onClose: () => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const open = async (path: string) => {
    const r = await deck().openEditor(path)
    setMsg({ ok: r.ok, text: r.message })
  }
  const copy = (path: string) => {
    deck().copy(path)
    setMsg({ ok: true, text: 'Copied the path' })
  }
  const rows = worktrees.length ? worktrees : dir ? [{ path: dir, repo: dir.split(/[\\/]/).pop() ?? dir, branch: null }] : []

  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wt-dialog" role="dialog" aria-label={`Worktrees of ${s.name}`}>
        <h3>
          Worktrees · {s.name}
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </h3>
        <div className="meta">
          {worktrees.length
            ? `${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'} this session created or worked in.`
            : 'This session has not made a worktree; it works in this folder.'}
        </div>
        <div className="wt-list">
          {rows.map((w) => (
            <div key={w.path} className="wt-row">
              <div className="wt-info">
                <div className="wt-name">
                  📁 <b>{w.repo}</b>
                  {worktrees.length > 0 && <> / {w.path.split(/[\\/]/).pop()}</>}
                </div>
                {w.branch && <div className="wt-branch mono">⎇ {w.branch}</div>}
                <div className="wt-path mono" onClick={() => copy(w.path)} title="Click to copy the path">
                  {w.path}
                </div>
              </div>
              {can('openEditor') && (
                <button className="btn primary" onClick={() => void open(w.path)} title="Open this folder in your default IDE">
                  Open in editor
                </button>
              )}
            </div>
          ))}
        </div>
        {msg && <div className={`meta ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      </div>
    </div>,
    document.body,
  )
}
