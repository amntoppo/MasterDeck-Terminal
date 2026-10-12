import { useEffect, useMemo, useState } from 'react'
import { messageFor, viewKind } from '@shared/fileView'
import type { FileRead } from '@shared/sessionFiles'
import type { Session } from '@shared/types'
import { deck } from '../deck'
import { highlightLines } from '../highlight'
import { can } from '../web'
import { MarkdownView } from './MarkdownView'

/**
 * A file of the session's folder: Markdown rendered (never its HTML), code highlighted for its
 * language, or a sentence when it is binary, too large or gone. Read again when the tab shows and
 * when the session's turn ends (it may have changed the file), and on Reload.
 */
export function FileTab({ session, path, visible }: { session: Session; path: string; visible: boolean }) {
  const [file, setFile] = useState<FileRead | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!visible) return
    let live = true
    void deck()
      .filesRead(session.key, path)
      .then((r) => live && setFile(r))
      .catch((e: unknown) => live && setFile({ ok: false, message: String(e) }))
    return () => {
      live = false
    }
  }, [session.key, path, visible, session.state, nonce])

  const view = viewKind(path)
  const text = file?.ok ? file.text : null
  const lines = useMemo(() => (text !== null && view.kind !== 'markdown' ? highlightLines(text, view.kind === 'code' ? view.lang : null) : []), [text, view.kind, view.kind === 'code' ? view.lang : ''])
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')

  const [note, setNote] = useState<string | null>(null)
  const openInEditor = async () => {
    const r = await deck().openEditor(`${session.cwd.replace(/\/$/, '')}/${path}`)
    setNote(r.ok ? r.message : `Editor: ${r.message}`)
    setTimeout(() => setNote(null), 2200)
  }

  return (
    <div className="ftab">
      <div className="ftab-head">
        <span className="ftab-path mono" title={path}>
          {path}
        </span>
        {view.kind === 'markdown' && text !== null && (
          <div className="seg" role="tablist" aria-label="Show">
            <button role="tab" aria-selected={mode === 'rendered'} className={mode === 'rendered' ? 'on' : undefined} onClick={() => setMode('rendered')}>
              Preview
            </button>
            <button role="tab" aria-selected={mode === 'source'} className={mode === 'source' ? 'on' : undefined} onClick={() => setMode('source')}>
              Source
            </button>
          </div>
        )}
        <button className="btn" onClick={() => setNonce((n) => n + 1)} title="Read the file again">
          Reload
        </button>
        {can('openEditor') && (
          <button className="btn" onClick={() => void openInEditor()}>
            Open in editor
          </button>
        )}
        {note && <span className="ftab-flash">{note}</span>}
      </div>
      {!file ? (
        <div className="ftab-note">Loading…</div>
      ) : !file.ok ? (
        <div className="ftab-note error">{file.message}</div>
      ) : file.refused ? (
        <div className="ftab-note">{messageFor(file.refused)}</div>
      ) : view.kind === 'markdown' && mode === 'rendered' ? (
        <div className="ftab-scroll ftab-md">
          <MarkdownView text={file.text ?? ''} html={false} />
        </div>
      ) : (
        <CodeLines lines={view.kind === 'markdown' ? highlightLines(file.text ?? '', 'markdown') : lines} />
      )}
    </div>
  )
}

/** Numbered lines of highlighted HTML (escaped by highlightLines). */
export function CodeLines({ lines }: { lines: string[] }) {
  // A trailing newline is not a line of its own.
  const shown = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  return (
    <div className="ftab-scroll">
      <table className="code hljs">
        <tbody>
          {shown.map((html, i) => (
            <tr key={i}>
              <td className="ln">{i + 1}</td>
              <td className="lc" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
