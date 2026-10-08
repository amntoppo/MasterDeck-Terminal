import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ticketLabel, ticketUrl } from '@shared/ticket'
import type { AppState, Session } from '@shared/types'
import { deck } from '../deck'
import { can } from '../web'
import type { SessionAction } from './Sidebar'

/**
 * Right-click on a session in the sidebar: the few things you reach for without opening it. Portalled
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
  starred,
  onStar,
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
  onMove: (where: 'top') => void
  starred: boolean
  onStar: () => void
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
  // Its newest PR (the list is oldest first).
  const pr = (state.sessionPrs[s.sessionId] ?? []).at(-1) ?? null
  const dir = state.stats[s.sessionId]?.currentDir ?? state.tails[s.sessionId]?.cwd ?? s.cwd
  const canStop = (s.kind === 'background' && !!s.bgId) || s.pid !== null

  return createPortal(
    <div className="menu session-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu" aria-label={`${s.name} actions`}>
      <div className="session-menu-head" title={s.name}>
        {s.name}
      </div>
      <button onClick={run(onOpen)}>Open</button>
      <button onClick={run(onStatus)}>Set status…</button>
      {can('summaryGet') && (
        <button onClick={run(() => onAction('summary'))} title="What it did: goal, changes, decisions, open questions">
          Summary
        </button>
      )}
      <hr />
      {s.issue !== null && <button onClick={run(() => deck().openExternal(ticketUrl(s.issueRepo, s.issue!)))}>Open ticket {ticketLabel(s.issueRepo, s.issue)}</button>}
      {pr && (
        <button onClick={run(() => deck().openExternal(pr))} title={pr}>
          Open PR {pr.replace(/^https:\/\/github\.com\/[^/]+\//, '').replace('/pull/', '#')}
        </button>
      )}
      {dir && can('openEditor') && (
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
      <button onClick={run(onStar)}>{starred ? 'Unstar' : 'Star'}</button>
      <button onClick={run(() => onMove('top'))}>Move to top</button>
      {canStop && (
        <>
          <hr />
          <button className="danger" onClick={run(onStatus)} title="Opens the status popup, where Stop ends it (its conversation is kept)">
            Stop session…
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
