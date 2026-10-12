import { useEffect, useMemo, useRef, useState } from 'react'
import { filterPaths, TREE_FILTER_MAX } from '@shared/fileTree'
import type { FileList } from '@shared/sessionFiles'
import type { Session } from '@shared/types'
import { deck } from '../deck'
import { sessionTabs } from '../sessionTabsStore'

/** ⌘P: a file of the open session's folder, picked by a fuzzy match, opens as a tab in its row. */
export function QuickOpen({ session, onClose }: { session: Session; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [list, setList] = useState<FileList | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    let live = true
    void deck()
      .filesList(session.key)
      .then((r) => live && setList(r))
      .catch((e: unknown) => live && setList({ ok: false, message: String(e) }))
    return () => {
      live = false
    }
  }, [session.key])
  const shown = useMemo(() => (list?.ok ? filterPaths(list.paths, q).slice(0, TREE_FILTER_MAX) : []), [list, q])
  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.pal-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  const open = (path: string) => {
    sessionTabs.open(session.key, { kind: 'file', path })
    onClose()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      setSel((i) => Math.min(shown.length - 1, i + 1))
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setSel((i) => Math.max(0, i - 1))
      e.preventDefault()
    } else if (e.key === 'Enter' && shown[sel]) open(shown[sel])
  }

  return (
    <div className="backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Open a file">
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={`Open a file in ${session.name}…`} spellCheck={false} />
        <div className="pal-list" ref={listRef}>
          {!list && <div className="empty">Reading the folder…</div>}
          {list && !list.ok && <div className="empty">{list.message}</div>}
          {list?.ok && shown.length === 0 && <div className="empty">No file matches.</div>}
          {shown.map((p, i) => (
            <div key={p} className={`pal-row ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => open(p)}>
              <span className="label">{p.slice(p.lastIndexOf('/') + 1)}</span>
              <span className="sub">{p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}</span>
            </div>
          ))}
        </div>
        <div className="pal-foot">↑↓ to move · ↵ to open in a tab · esc to close</div>
      </div>
    </div>
  )
}
