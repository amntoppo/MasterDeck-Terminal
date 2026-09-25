import { useCallback, useEffect, useState } from 'react'
import type { QueueEdit } from '@shared/ipc'
import type { AppState } from '@shared/types'
import { deck } from '../deck'

interface Props {
  state: AppState
  /** The session of the focused tab: its queue shows unless another one is picked here. */
  activeKey: string | null
  onClose: () => void
}

/**
 * One session's /queue (the queue skill): the prompts its Stop hook runs, one per finished
 * response, first to last. Reads and edits ~/.claude/queue/<session id>.jsonl through the app.
 */
export function QueuePanel({ state, activeKey, onClose }: Props) {
  const [picked, setPicked] = useState<string | null>(null)
  const [items, setItems] = useState<string[]>([])
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A new focused tab shows its own queue again.
  useEffect(() => setPicked(null), [activeKey])

  const sessions = state.sessions.filter((s) => s.state !== 'done')
  const key = picked ?? activeKey
  const session = sessions.find((s) => s.key === key) ?? null
  const sid = session?.sessionId ?? null

  const load = useCallback(async () => {
    if (!sid) return setItems([])
    setItems(await deck().queueList(sid))
  }, [sid])

  // The Stop hook takes prompts off the file as the session works: re-read while shown.
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => setMsg(null), [sid])

  const edit = async (e: QueueEdit) => {
    if (!sid) return
    const r = await deck().queueEdit(sid, e)
    setItems(r.items)
    setMsg(r.ok ? null : r.message)
    return r.ok
  }
  const add = async () => {
    if (!text.trim()) return
    if (await edit({ op: 'add', text })) setText('')
  }
  const sendNext = async () => {
    if (!session) return
    setBusy(true)
    const r = await deck().queueSendNext(session.key)
    setBusy(false)
    setMsg(r.ok ? 'Sent the first prompt' : r.message)
    void load()
  }

  const when =
    session?.state === 'working'
      ? 'Each prompt runs after the current response ends, first to last.'
      : session?.state === 'needs-input'
        ? 'The session is waiting on a prompt; the queue continues after its next response.'
        : 'The session is idle: the queue runs after its next response, or send the first prompt now.'

  return (
    <section className="queue">
      <div className="mhead">
        <strong>Queue{items.length ? ` (${items.length})` : ''}</strong>
        <span className="muted">prompts run after each response, first to last</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Hide the queue (Queue Prompts shows it again)">
          ×
        </button>
      </div>
      <div className="queue-head">
        <select className="fsel" value={key ?? ''} onChange={(e) => setPicked(e.target.value || null)} title="Whose queue">
          {!session && <option value="">Pick a session…</option>}
          {sessions.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
              {s.key === activeKey ? ' (open tab)' : ''}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {session && session.state !== 'working' && items.length > 0 && (
          <button className="btn" disabled={busy} onClick={() => void sendNext()} title="Type the first queued prompt into the session now">
            {busy ? 'Sending…' : 'Send next now'}
          </button>
        )}
        <button className="btn" disabled={!items.length} onClick={() => void edit({ op: 'clear' })}>
          Clear
        </button>
      </div>
      {!state.hooks.queue && (
        <div className="banner">Queue hooks are not installed, so queued prompts never run. Turn them on in Settings → GitHub &amp; board → Hooks.</div>
      )}
      {msg && (
        <div className="banner" style={{ color: 'var(--muted)', background: 'var(--bg-2)' }} onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}
      {!session ? (
        <div className="empty">Open a session tab, or pick one above, to see its queue.</div>
      ) : (
        <>
          <div className="meta queue-when">{when}</div>
          <ol className="queue-list">
            {items.length === 0 && <li className="empty">Nothing queued. Add a prompt below, or type /queue &lt;prompt&gt; in the session.</li>}
            {items.map((t, i) => (
              <li key={`${i}:${t}`} className="queue-item">
                <span className="queue-n">{i + 1}</span>
                <span className="queue-text">{t}</span>
                <span className="queue-tools">
                  <button className="icon-btn" title="Run earlier" disabled={i === 0} onClick={() => void edit({ op: 'move', index: i, text: t, to: i - 1 })}>
                    ↑
                  </button>
                  <button className="icon-btn" title="Run later" disabled={i === items.length - 1} onClick={() => void edit({ op: 'move', index: i, text: t, to: i + 1 })}>
                    ↓
                  </button>
                  <button className="icon-btn" title="Remove" onClick={() => void edit({ op: 'remove', index: i, text: t })}>
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div className="queue-add">
            <textarea
              value={text}
              placeholder={`Queue a prompt for ${session.name}…`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add()
              }}
            />
            <button className="btn primary" disabled={!text.trim()} onClick={() => void add()} title="⌘↵">
              Add to queue
            </button>
          </div>
        </>
      )}
    </section>
  )
}
