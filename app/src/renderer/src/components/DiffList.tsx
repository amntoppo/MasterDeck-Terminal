import { useRef, useState } from 'react'
import type { ChangedFile } from '@shared/diff'
import type { DiffBase } from '@shared/sessionTabs'
import type { Session } from '@shared/types'
import { deck, load, save } from '../deck'
import { sessionTabs } from '../sessionTabsStore'
import { usePull } from '../usePull'

const BASE_KEY = 'diff-base'
/** Rows drawn; a folder with more changes says how many are left out. */
const SHOW_MAX = 500
const LETTER: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }

/**
 * Details → Diff: the files changed in the session's folder, against the last commit or the whole
 * branch, kept live while it shows (usePull). A click opens the file's diff as a tab in the
 * session's row, or focuses it when it is open.
 */
export function DiffList({ session, onCount }: { session: Session; onCount: (n: number | null) => void }) {
  const [base, setBaseState] = useState<DiffBase>(() => (load<string>(BASE_KEY, 'uncommitted') === 'branch' ? 'branch' : 'uncommitted'))
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [more, setMore] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // The base now, for an answer that comes back after the switch was flipped.
  const baseNow = useRef(base)
  const setBase = (b: DiffBase) => {
    baseNow.current = b
    setBaseState(b)
    save(BASE_KEY, b)
    setFiles(null)
    setError(null)
  }
  usePull(true, `${session.key}:${session.state}:${base}`, async () => {
    // The panel stays mounted when hidden: ask nothing then.
    if (!ref.current || ref.current.offsetParent === null) return false
    const asked = base
    const r = await deck().diffList(session.key, asked)
    if (asked !== baseNow.current) return
    if (r.ok) {
      // The same answer as last time draws nothing again.
      setFiles((cur) => (cur && JSON.stringify(cur) === JSON.stringify(r.files) ? cur : r.files))
      setMore(r.more ?? 0)
      setError(null)
      onCount(r.files.length)
    } else {
      // Keep the last list on screen; say what failed.
      setError(r.message)
      if (!files) onCount(null)
    }
  })

  const add = files?.reduce((n, f) => n + f.add, 0) ?? 0
  const del = files?.reduce((n, f) => n + f.del, 0) ?? 0
  return (
    <div className="dsec diff-list" ref={ref}>
      <div className="diff-list-head">
        <div className="seg" role="tablist" aria-label="Compare with">
          <button role="tab" aria-selected={base === 'uncommitted'} className={base === 'uncommitted' ? 'on' : undefined} onClick={() => setBase('uncommitted')} title="Changes since the last commit, untracked files included">
            Uncommitted
          </button>
          <button role="tab" aria-selected={base === 'branch'} className={base === 'branch' ? 'on' : undefined} onClick={() => setBase('branch')} title="Everything since the branch left the default branch: what a PR would hold">
            Branch
          </button>
        </div>
        {files && files.length > 0 && (
          <span className="diff-sum">
            {files.length} {files.length === 1 ? 'file' : 'files'} <span className="plus">+{add}</span> <span className="minus">−{del}</span>
          </span>
        )}
      </div>
      {error && <div className="diff-err">{error}</div>}
      {!files && !error && <div className="empty">Reading changes…</div>}
      {files && files.length === 0 && <div className="empty">{base === 'uncommitted' ? 'No changes since the last commit.' : 'No changes on this branch.'}</div>}
      {files && files.length > 0 && (
        <ul className="diff-files">
          {files.slice(0, SHOW_MAX).map((f) => (
            <li key={f.path}>
              <button
                className={`diff-file ${f.status}`}
                onClick={() => sessionTabs.open(session.key, { kind: 'diff', path: f.path, base })}
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                <span className={`diff-st ${f.status}`} aria-label={f.status}>
                  {LETTER[f.status]}
                </span>
                <span className="diff-path">
                  <span className="diff-name">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
                  <span className="diff-dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                </span>
                {f.binary ? (
                  <span className="diff-n">binary</span>
                ) : (
                  <span className="diff-n">
                    <span className="plus">+{f.add}</span> <span className="minus">−{f.del}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {files && (files.length > SHOW_MAX || more > 0) && (
        <div className="empty">
          {(Math.max(0, files.length - SHOW_MAX) + more).toLocaleString('en-US')} more changed files are not listed (a build folder git does not ignore?).
        </div>
      )}
    </div>
  )
}
