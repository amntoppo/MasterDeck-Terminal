import { useEffect, useRef, useState } from 'react'
import { splitRows, type DiffLine, type Hunk } from '@shared/diff'
import { DIFF_MAX_LINES } from '@shared/fileView'
import type { DiffRead } from '@shared/sessionFiles'
import type { DiffBase } from '@shared/sessionTabs'
import type { Session } from '@shared/types'
import { deck, load, save } from '../deck'
import { sessionTabs } from '../sessionTabsStore'

/** Narrower than this, old and new side by side do not fit: the diff stays unified. */
const SPLIT_MIN_PX = 760
const SPLIT_KEY = 'diff-split'

/** The pane's width, followed as it is resized. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/**
 * A changed file's diff: unified (− and + lines with old and new numbers) or, on a wide pane, old
 * and new side by side. Read again when the tab shows, when the session's turn ends, and on Reload.
 */
export function DiffTab({ session, path, base, visible }: { session: Session; path: string; base: DiffBase; visible: boolean }) {
  const [diff, setDiff] = useState<DiffRead | null>(null)
  const [nonce, setNonce] = useState(0)
  const [split, setSplitState] = useState(() => load<boolean>(SPLIT_KEY, false) === true)
  const [ref, width] = useWidth()
  const canSplit = width >= SPLIT_MIN_PX
  useEffect(() => {
    if (!visible) return
    let live = true
    void deck()
      .diffFile(session.key, path, base)
      .then((r) => live && setDiff(r))
      .catch((e: unknown) => live && setDiff({ ok: false, message: String(e) }))
    return () => {
      live = false
    }
  }, [session.key, path, base, visible, session.state, nonce])
  const setSplit = (v: boolean) => {
    setSplitState(v)
    save(SPLIT_KEY, v)
  }
  const d = diff?.ok ? diff.diff : null
  const empty = d && !d.binary && d.hunks.length === 0

  return (
    <div className="ftab" ref={ref}>
      <div className="ftab-head">
        <span className="ftab-path mono" title={path}>
          {path}
        </span>
        <span className="diff-base">{base === 'branch' ? 'Whole branch' : 'Uncommitted'}</span>
        {canSplit && (
          <div className="seg" role="tablist" aria-label="Layout">
            <button role="tab" aria-selected={!split} className={!split ? 'on' : undefined} onClick={() => setSplit(false)}>
              Unified
            </button>
            <button role="tab" aria-selected={split} className={split ? 'on' : undefined} onClick={() => setSplit(true)}>
              Split
            </button>
          </div>
        )}
        <button className="btn" onClick={() => setNonce((n) => n + 1)} title="Read the diff again">
          Reload
        </button>
        <button className="btn" onClick={() => sessionTabs.open(session.key, { kind: 'file', path })} title="Open the whole file in a tab">
          Open file
        </button>
      </div>
      {!diff ? (
        <div className="ftab-note">Loading…</div>
      ) : !diff.ok ? (
        <div className="ftab-note error">{diff.message}</div>
      ) : d?.binary ? (
        <div className="ftab-note">Binary file changed. Its changes are not shown here.</div>
      ) : empty ? (
        <div className="ftab-note">No changes in this file{base === 'uncommitted' ? ' since the last commit' : ' on this branch'}.</div>
      ) : (
        <div className="ftab-scroll">
          <table className={`code diff${split && canSplit ? ' split' : ''}`}>
            <tbody>{d!.hunks.map((h, i) => (split && canSplit ? <SplitHunk key={i} hunk={h} /> : <UnifiedHunk key={i} hunk={h} />))}</tbody>
          </table>
          {d!.truncated && <div className="ftab-note">The diff is longer than {DIFF_MAX_LINES.toLocaleString('en-US')} lines; the rest is not shown.</div>}
        </div>
      )}
    </div>
  )
}

const SIGN = { ctx: ' ', add: '+', del: '−' } as const

function HunkHead({ header, cols }: { header: string; cols: number }) {
  return (
    <tr className="hunk">
      <td colSpan={cols}>{header}</td>
    </tr>
  )
}

function UnifiedHunk({ hunk }: { hunk: Hunk }) {
  return (
    <>
      <HunkHead header={hunk.header} cols={4} />
      {hunk.lines.map((l, i) => (
        <tr key={i} className={l.kind}>
          <td className="ln">{l.kind !== 'add' ? l.old : ''}</td>
          <td className="ln">{l.kind !== 'del' ? l.new : ''}</td>
          <td className="sign">{SIGN[l.kind]}</td>
          <td className="lc">
            {l.text || ' '}
            {l.noNewline && <span className="nonl">  (no newline at end of file)</span>}
          </td>
        </tr>
      ))}
    </>
  )
}

function Side({ line, side }: { line: DiffLine | null; side: 'old' | 'new' }) {
  if (!line) return <td className="ln" />
  const n = side === 'old' ? (line.kind !== 'add' ? line.old : '') : line.kind !== 'del' ? line.new : ''
  return <td className="ln">{n}</td>
}

function SplitHunk({ hunk }: { hunk: Hunk }) {
  return (
    <>
      <HunkHead header={hunk.header} cols={4} />
      {splitRows(hunk).map((r, i) => (
        <tr key={i}>
          <Side line={r.left} side="old" />
          <td className={`lc half ${r.left ? r.left.kind : 'none'}`}>{r.left ? r.left.text || ' ' : ''}</td>
          <Side line={r.right} side="new" />
          <td className={`lc half ${r.right ? r.right.kind : 'none'}`}>{r.right ? r.right.text || ' ' : ''}</td>
        </tr>
      ))}
    </>
  )
}
