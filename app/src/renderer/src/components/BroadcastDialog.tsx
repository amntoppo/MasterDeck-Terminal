import { useEffect, useMemo, useState } from 'react'
import { MASTER_NAME } from '@shared/derive'
import { canSend } from '@shared/send'
import type { AppState, CliResult } from '@shared/types'
import { deck } from '../deck'

interface Props {
  state: AppState
  onClose: () => void
  /** Keys of sessions with a live tab (sent through the tab instead of a hidden attach). */
  livePanes: Set<string>
}

const PRESETS = ['Rebase on dev and resolve conflicts.', 'Run the tests and fix failures.', 'Give me a one-line status update.', 'Commit and push your work so far.']

export function BroadcastDialog({ state, onClose, livePanes }: Props) {
  const masterUp = state.master.kind === 'attached' || state.master.kind === 'elsewhere'
  const candidates = useMemo(
    () => state.sessions.filter((s) => s.name !== MASTER_NAME && s.state !== 'done').sort((a, b) => a.name.localeCompare(b.name)),
    [state.sessions],
  )
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(candidates.filter((s) => s.kind === 'background' && (s.state === 'idle' || s.state === 'working')).map((s) => s.key)),
  )
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, CliResult>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const send = async () => {
    setBusy(true)
    const targets = candidates.filter((s) => picked.has(s.key))
    // One at a time: each hidden attach takes a couple of seconds and they shouldn't pile up.
    for (const s of targets) {
      const r = await deck().sendText(s.key, text)
      setResults((cur) => ({ ...cur, [s.key]: r }))
    }
    setBusy(false)
  }

  const toggle = (k: string) => setPicked((cur) => {
    const n = new Set(cur)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    return n
  })

  const sentCount = Object.values(results).filter((r) => r.ok).length
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="Broadcast" style={{ borderTopColor: 'var(--purple)' }}>
        <h3>Broadcast a message</h3>
        <div className="meta">Typed into each chosen session as if you wrote it. Sessions waiting on a prompt are skipped, so the text can't answer a permission dialog.</div>
        <label>Message</label>
        <textarea className="instructions" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Rebase on dev and run the tests." autoFocus />
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p} className="chip btnlike" onClick={() => setText(p)}>
              {p}
            </button>
          ))}
        </div>
        <label>
          Sessions ({picked.size} chosen) ·{' '}
          <button className="link-btn" onClick={() => setPicked(new Set(candidates.filter((s) => canSend(s, livePanes.has(s.key), masterUp).ok).map((s) => s.key)))}>
            all that can receive
          </button>{' '}
          ·{' '}
          <button className="link-btn" onClick={() => setPicked(new Set())}>
            none
          </button>
        </label>
        <div className="suggest">
          {candidates.map((s) => {
            const route = canSend(s, livePanes.has(s.key), masterUp)
            const r = results[s.key]
            return (
              <label key={s.key} className={`mpick-row ${route.ok ? '' : 'disabled'}`} title={route.ok ? `via ${route.via}` : route.reason}>
                <input type="checkbox" disabled={!route.ok || busy} checked={route.ok && picked.has(s.key)} onChange={() => toggle(s.key)} />
                <span className={`dot ${s.state}`} />
                <span className="label">{s.name}</span>
                {s.issue !== null && <span className="num">#{s.issue}</span>}
                <span className="sub">{r ? (r.ok ? '✓ sent' : `✗ ${r.message}`) : route.ok ? route.via : route.reason}</span>
              </label>
            )
          })}
        </div>
        <div className="foot">
          <span className="grow meta">{busy ? 'Sending…' : Object.keys(results).length ? `${sentCount} of ${Object.keys(results).length} sent` : ''}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            {Object.keys(results).length ? 'Close' : 'Cancel'}
          </button>
          {Object.keys(results).length === 0 && (
            <button className="btn primary" onClick={send} disabled={busy || !text.trim() || picked.size === 0}>
              Send to {picked.size}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
