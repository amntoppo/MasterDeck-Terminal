import { useEffect, useMemo, useState } from 'react'
import { buildTree, filterPaths, type TreeNode } from '@shared/fileTree'
import type { FileList } from '@shared/sessionFiles'
import type { Session } from '@shared/types'
import { deck } from '../deck'
import { sessionTabs } from '../sessionTabsStore'

/** Details → Files: the session's folder as a tree, with a filter; a click opens the file as a tab. */
export function FileTree({ session }: { session: Session }) {
  const [list, setList] = useState<FileList | null>(null)
  const [query, setQuery] = useState('')
  const [nonce, setNonce] = useState(0)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    let live = true
    void deck()
      .filesList(session.key)
      .then((r) => live && setList(r))
      .catch((e: unknown) => live && setList({ ok: false, message: String(e) }))
    return () => {
      live = false
    }
  }, [session.key, nonce])

  const paths = list?.ok ? list.paths : null
  const matches = useMemo(() => (paths && query.trim() ? filterPaths(paths, query) : null), [paths, query])
  const tree = useMemo(() => (paths && !matches ? buildTree(paths) : []), [paths, matches])
  const openFile = (path: string) => sessionTabs.open(session.key, { kind: 'file', path })
  const toggle = (p: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const node = (n: TreeNode, depth: number) =>
    n.children ? (
      <li key={n.path}>
        <button className="ft-row ft-dir" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => toggle(n.path)} aria-expanded={open.has(n.path)}>
          <span className="ft-caret">{open.has(n.path) ? '▾' : '▸'}</span>
          {n.name}
        </button>
        {open.has(n.path) && <ul>{n.children.map((c) => node(c, depth + 1))}</ul>}
      </li>
    ) : (
      <li key={n.path}>
        <button className="ft-row" style={{ paddingLeft: 18 + depth * 12 }} onClick={() => openFile(n.path)} title={n.path}>
          {n.name}
        </button>
      </li>
    )

  return (
    <div className="dsec file-tree">
      <div className="ft-head">
        <input className="filter" placeholder="Find a file…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a file" />
        <button className="btn" onClick={() => setNonce((n) => n + 1)} title="Read the folder again">
          Reload
        </button>
      </div>
      {!list ? (
        <div className="empty">Reading the folder…</div>
      ) : !list.ok ? (
        <div className="diff-err">{list.message}</div>
      ) : matches ? (
        matches.length ? (
          <ul className="ft">
            {matches.map((p) => (
              <li key={p}>
                <button className="ft-row ft-match" onClick={() => openFile(p)} title={p}>
                  <span className="diff-name">{p.slice(p.lastIndexOf('/') + 1)}</span>
                  <span className="diff-dir">{p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">No file matches.</div>
        )
      ) : list.paths.length ? (
        <ul className="ft">{tree.map((n) => node(n, 0))}</ul>
      ) : (
        <div className="empty">No files.</div>
      )}
      {list?.ok && list.truncated && <div className="empty">Only the first {list.paths.length.toLocaleString('en-US')} files are listed.</div>}
    </div>
  )
}
