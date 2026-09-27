import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ticketLabel, ticketUrl } from '@shared/ticket'
import type { AppState, Session } from '@shared/types'
import { deck } from '../deck'
import type { SessionAction } from './Sidebar'

/**
 * Right-click on a session in the sidebar: the things you reach for without opening it. Portalled
 * to the end of the page (after every window drag region) and kept inside the window.
 */
export function SessionMenu({
  s,
  x,
  y,
  state,
  onClose,
  onOpen,
  onStatus,
  onAction,
  onMove,
  flash,
}: {
  s: Session
  x: number
  y: number
  state: AppState
  onClose: () => void
  onOpen: () => void
  onStatus: () => void
  onAction: (a: SessionAction) => void
  onMove: (where: 'top' | 'bottom') => void
  flash: (m: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
  }, [x, y])
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const run = (f: () => void | Promise<void>) => () => {
    onClose()
    void f()
  }
  const send = async (text: string, done: string) => {
    const r = await deck().sendText(s.key, text)
    flash(r.ok ? done : r.message)
  }
  const copy = (text: string, what: string) => {
    deck().copy(text)
    flash(`Copied ${what}`)
  }
  const prs = state.sessionPrs[s.sessionId] ?? []
  const dir = state.stats[s.sessionId]?.currentDir ?? state.tails[s.sessionId]?.cwd ?? s.cwd
  const idle = s.state === 'idle'
  const canStop = (s.kind === 'background' && !!s.bgId) || s.pid !== null

  return createPortal(
    <div className="menu session-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu" aria-label={`${s.name} actions`}>
      <div className="session-menu-head" title={s.name}>
        {s.name}
      </div>
      <button onClick={run(onOpen)}>Open</button>
      <button onClick={run(onStatus)}>Set status…</button>
      <button onClick={run(() => onAction('summary'))} title="What it did: goal, changes, decisions, open questions">
        Summary
      </button>
      <button onClick={run(() => onAction('queue'))} title="Prompts it runs after each response">
        Queue prompts
      </button>
      <hr />
      <button disabled={!idle} onClick={run(() => send('continue', `Nudged ${s.name}`))} title={idle ? 'Type "continue" into it' : 'Only while it is idle'}>
        Nudge: continue
      </button>
      <button disabled={s.state === 'needs-input'} onClick={run(() => send('/compact', `Compacting ${s.name}`))} title="Type /compact into it: frees context">
        Compact context
      </button>
      {state.config.masterEnabled && (
        <button onClick={run(() => onAction('ask-master'))} title="Ask master-agent where this session stands">
          Ask master about it
        </button>
      )}
      <hr />
      {s.issue !== null && <button onClick={run(() => deck().openExternal(ticketUrl(s.issueRepo, s.issue!)))}>Open ticket {ticketLabel(s.issueRepo, s.issue)} on GitHub</button>}
      {prs.map((u) => (
        <button key={u} onClick={run(() => deck().openExternal(u))}>
          Open PR {u.replace(/^https:\/\/github\.com\/[^/]+\//, '').replace('/pull/', '#')}
        </button>
      ))}
      {dir && (
        <button
          onClick={run(async () => {
            const r = await deck().openEditor(dir)
            flash(r.ok ? r.message : `Editor: ${r.message}`)
          })}
          title={dir}
        >
          Open folder in editor
        </button>
      )}
      <hr />
      <button onClick={run(() => onMove('top'))}>Move to top</button>
      <button onClick={run(() => onMove('bottom'))}>Move to bottom</button>
      <button onClick={run(() => onAction('close-tab'))} title="Close its tab; the session keeps running">
        Close tab
      </button>
      <hr />
      <button onClick={run(() => copy(s.name, 'the name'))}>Copy name</button>
      <button onClick={run(() => copy(`claude --resume ${s.sessionId}`, 'the resume command'))}>Copy resume command</button>
      {s.bgId && <button onClick={run(() => copy(`claude attach ${s.bgId}`, 'the attach command'))}>Copy attach command</button>}
      {canStop && (
        <>
          <hr />
          <button className="danger" onClick={run(onStatus)} title="In the status popup: stop it (its conversation is kept)">
            Stop session…
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
