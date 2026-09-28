import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HistoryHit, TranscriptWindow } from '@shared/history'
import { formatAgo } from '@shared/format'
import type { AppState, Session } from '@shared/types'
import { deck, useNow } from '../deck'

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
  onClose: () => void
}

/** A found place: a session's transcript and the entry (uuid) to show; null uuid = its first match. */
type Target = { hit: HistoryHit; uuid: string | null; at: number }

/**
 * History (⌘⇧F): search every session transcript; a result opens that conversation in the reader,
 * scrolled to the message it was found in, with the text highlighted. Up and down step through the
 * other matches in it.
 */
export function HistoryDialog({ state, onOpenSession, onClose }: Props) {
  const now = useNow(60_000)
  const [q, setQ] = useState('')
  const [searched, setSearched] = useState('')
  const [hits, setHits] = useState<HistoryHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<Target | null>(null)
  // The part of the conversation on screen (a window around the match; main keeps the rest).
  const [win, setWin] = useState<TranscriptWindow | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const refs = useRef(new Map<string, HTMLDivElement>())
  const messages = win?.messages ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const search = async (text = q) => {
    const t = text.trim()
    if (t.length < 2) return
    setBusy(true)
    setSearched(t)
    setTarget(null)
    setWin(null)
    setHits(await deck().searchHistory(t))
    setBusy(false)
  }
  // Search as you type, after a short pause.
  useEffect(() => {
    if (q.trim().length < 2 || q.trim() === searched) return
    const id = setTimeout(() => void search(q), 500)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  // Load the window of the conversation around `focus`, then scroll to it.
  const load = (hit: HistoryHit, focus: string | null) => {
    let alive = true
    setLoading(true)
    setFailed(false)
    void deck()
      .historyTranscript(hit.path, searched, focus)
      .then((w) => {
        if (!alive) return
        setLoading(false)
        setWin(w)
        setFailed(!w)
        setCurrent(w?.focus ?? null)
      })
    return () => {
      alive = false
    }
  }
  useEffect(() => {
    if (!target) return
    return load(target.hit, target.uuid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])
  useEffect(() => {
    if (current) requestAnimationFrame(() => refs.current.get(current)?.scrollIntoView({ block: 'center' }))
  }, [current, win])

  const needle = searched.toLowerCase()
  const matching = win?.matches ?? []
  const cursor = current ? Math.max(0, matching.indexOf(current)) : 0
  // Step through every match in the conversation; one outside the window loads the window around it.
  const step = (d: number) => {
    if (!matching.length || !target) return
    const next = matching[(cursor + d + matching.length) % matching.length]
    if (win?.messages.some((m) => m.uuid === next)) setCurrent(next)
    else load(target.hit, next)
  }
  const hit = target?.hit ?? null
  const live = hit ? state.sessions.find((s) => s.sessionId === hit.sessionId && s.state !== 'done') : undefined

  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog history-dialog" role="dialog" aria-label="History">
        <div className="hd-search">
          <input
            className="input"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            placeholder="Search every session: a file, an error, a phrase…"
            spellCheck={false}
            aria-label="Search history"
          />
          <span className="muted">{busy ? 'Searching…' : hits ? `${hits.length} session${hits.length === 1 ? '' : 's'}` : 'Exact text, any case'}</span>
          <kbd className="hd-kbd">⌘⇧F</kbd>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="hd-body">
          <div className="hd-results">
            {!hits && !busy && <div className="empty">Type at least two characters. Results are the sessions that mentioned or touched it, newest first.</div>}
            {hits?.length === 0 && <div className="empty">No session mentions “{searched}”.</div>}
            {hits?.map((h) => {
              const on = target?.hit.path === h.path
              return (
                <div key={h.path} className={`hd-hit ${on ? 'on' : ''}`}>
                  <button className="hd-hit-top" onClick={() => setTarget({ hit: h, uuid: h.snippetIds?.[0] ?? null, at: Date.now() })}>
                    <b>{h.title}</b>
                    <span className="muted">
                      {h.matches} match{h.matches === 1 ? '' : 'es'} · {formatAgo(now - h.lastActivity)} ago
                    </span>
                  </button>
                  {h.cwd && <div className="hd-cwd mono">{h.cwd.replace(deck().home, '~')}</div>}
                  {h.snippets.map((s, i) => (
                    <button key={i} className={`hd-snip ${on && target?.uuid === (h.snippetIds?.[i] ?? null) ? 'on' : ''}`} onClick={() => setTarget({ hit: h, uuid: h.snippetIds?.[i] ?? null, at: Date.now() })}>
                      …<Marked text={s} needle={needle} />…
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="hd-reader">
            {!hit && <div className="empty">Pick a result to read that conversation at the match.</div>}
            {hit && (
              <>
                <div className="hd-reader-head">
                  <b>{hit.title}</b>
                  <span className="mono muted">{hit.sessionId.slice(0, 8)}</span>
                  <span style={{ flex: 1 }} />
                  {matching.length > 0 && (
                    <span className="hd-nav">
                      <span className="muted">
                        {cursor + 1} / {matching.length}
                      </span>
                      <button className="icon-btn" onClick={() => step(-1)} aria-label="Previous match" title="Previous match">
                        ↑
                      </button>
                      <button className="icon-btn" onClick={() => step(1)} aria-label="Next match" title="Next match">
                        ↓
                      </button>
                    </span>
                  )}
                  {msg && <span className="muted">{msg}</span>}
                  <button className="btn" onClick={() => deck().copy(hit.sessionId)}>
                    Copy id
                  </button>
                  {live ? (
                    <button
                      className="btn primary"
                      onClick={() => {
                        onOpenSession(live)
                        onClose()
                      }}
                    >
                      Open session
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      onClick={async () => {
                        setMsg('Resuming…')
                        const r = await deck().resumeSession(hit.sessionId, hit.title.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60) || 'resumed', hit.cwd)
                        setMsg(r.ok ? `Resuming as ${r.message}` : r.message)
                      }}
                    >
                      Resume
                    </button>
                  )}
                </div>
                <div className="hd-messages">
                  {loading && <div className="empty">Reading the conversation…</div>}
                  {!loading && failed && <div className="empty">This conversation can't be read.</div>}
                  {win && win.start > 0 && (
                    <button className="btn hd-more" onClick={() => target && load(target.hit, win.messages[0]?.uuid ?? null)}>
                      {win.start} earlier messages · show more
                    </button>
                  )}
                  {messages?.map((m) => (
                    <div
                      key={m.uuid}
                      ref={(el) => {
                        if (el) refs.current.set(m.uuid, el)
                        else refs.current.delete(m.uuid)
                      }}
                      className={`hd-msg role-${m.role} ${m.uuid === current ? 'current' : ''}`}
                    >
                      <div className="hd-role">
                        {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Claude' : m.role === 'tool' ? 'Tool' : 'Result'}
                        {m.at && <span className="muted"> · {new Date(m.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
                      </div>
                      <div className="hd-text">
                        <Marked text={m.text.length > 6000 ? `${m.text.slice(0, 6000)}…` : m.text} needle={needle} />
                      </div>
                    </div>
                  ))}
                  {win && win.start + win.messages.length < win.total && (
                    <button className="btn hd-more" onClick={() => target && load(target.hit, win.messages[win.messages.length - 1]?.uuid ?? null)}>
                      {win.total - win.start - win.messages.length} later messages · show more
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Text with each occurrence of `needle` (any case) highlighted. */
function Marked({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>
  const out: React.ReactNode[] = []
  const lower = text.toLowerCase()
  let i = 0
  for (let j = lower.indexOf(needle); j >= 0; j = lower.indexOf(needle, i)) {
    out.push(<Fragment key={i}>{text.slice(i, j)}</Fragment>)
    out.push(<mark key={`m${j}`}>{text.slice(j, j + needle.length)}</mark>)
    i = j + needle.length
  }
  out.push(<Fragment key="end">{text.slice(i)}</Fragment>)
  return <>{out}</>
}
