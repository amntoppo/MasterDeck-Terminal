import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatRefreshed } from '@shared/format'
import { describeDevice, showRemoteDot, type Presence } from '@shared/remotePresence'
import type { View } from './Sidebar'
import { isWeb, screenOk } from '../web'
import { canRecord, RecordMeeting } from './RecordMeeting'
import type { MeetingLive } from '@shared/meetings'
import { meetingsHere } from '../meetingLinks'
import { badgeLabel } from '../updates'
import { dropBefore, isDefaultOrder, isRailMark, moveStep, moveTo, RAIL_DEFAULT, RAIL_SEP, RAIL_SPACER, railOrder, toSaved, type RailEntry } from '@shared/railOrder'

/** Stroke icons for the rail (24px grid). */
const ICONS: Record<string, string> = {
  terminals: 'M4 17l6-5-6-5M12 19h8',
  board: 'M3 5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM10 5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1zM17 5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z',
  prs: 'M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 8v8M18 16V9a3 3 0 0 0-3-3h-4',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  costs: 'M12 3v18M16.5 7.5c0-1.9-2-3-4.5-3s-4.5 1.1-4.5 3 2 2.6 4.5 3 4.5 1.1 4.5 3-2 3-4.5 3-4.5-1.1-4.5-3',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  janitor: 'M14 3l7 7M9 8l7 7M4 21l6-6M10 15l-3-3 5-5 5 5-5 5z',
  notes: 'M4 20h4l10-10-4-4L4 16zM13 7l4 4M12 20h8',
  meetings: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2',
  schedules: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 3',
  workflow: 'M5 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 6h10M6 8l5 8M18 8l-5 8',
  broadcast: 'M3 11v2a2 2 0 0 0 2 2h1l5 4V5L6 9H5a2 2 0 0 0-2 2zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14',
  standup: 'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h8M8 12h8M8 16h5',
  skills: 'M12 2l3 6 6 .9-4.5 4.3 1 6.3L12 16.8 6.5 19.5l1-6.3L3 8.9 9 8z',
  palette: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  master: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
}

export function RailIcon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  )
}

export type RailAction = 'palette' | 'broadcast' | 'standup' | 'skills'

interface Props {
  view: View
  onView: (v: View) => void
  onAction: (a: RailAction) => void
  /** Needs-you items (badge on Terminals). */
  needs: number
  /** PRs waiting on the user (badge on PRs). */
  prAttention: number
  /** Browsers and phones/API clients connected to this Mac right now. */
  remote: Presence[]
  /** Open Settings → Remote. */
  onRemote: () => void
  /** The Notes panel is open. */
  notesOpen: boolean
  onNotes: () => void
  /** An update to show on the Settings icon (the window only). */
  update?: 'required' | 'ready' | 'available' | null
  /** Record a meeting (macOS, the window only; RecordMeeting hides itself elsewhere). */
  meeting?: {
    live: MeetingLive | null | undefined
    agreed: boolean
    open: boolean
    setOpen: (open: boolean) => void
    onSetup: () => void
  }
  /** The saved icon order (Settings.railOrder; empty: the default) and where a new one is saved. */
  order: string[]
  onOrder: (saved: string[]) => void
}

/** The blinking amber dot (only while something remote is connected) and its hover/focus card. */
function RemoteIndicator({ remote, onRemote }: { remote: Presence[]; onRemote: () => void }) {
  const [now, setNow] = useState(Date.now)
  const [esc, setEsc] = useState(false)
  const cardId = useId()
  useEffect(() => {
    if (!remote.length) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [remote.length])
  if (!showRemoteDot(remote.length, isWeb())) return null
  const n = remote.length
  return (
    <div
      className={`ri ${esc ? 'esc' : ''}`}
      onMouseEnter={() => (setNow(Date.now()), setEsc(false))}
      onFocus={() => setEsc(false)}
      onKeyDown={(e) => e.key === 'Escape' && setEsc(true)}
    >
      <button
        className="rb"
        aria-label={`${n} remote connection${n === 1 ? '' : 's'} active`}
        aria-describedby={cardId}
        onClick={(e) => {
          e.currentTarget.blur()
          onRemote()
        }}
      >
        <span className="ri-dot" />
      </button>
      <div id={cardId} className="ri-card" role="group" aria-label="Remote connections">
        <div className="ri-box">
        <div className="ri-head">Remote connections ({n})</div>
        {remote.map((r, i) => (
          <div key={`${i}:${r.kind}:${r.id}`} className="ri-row">
            <div className="ri-name">{r.name}</div>
            <div className="ri-sub">{describeDevice(r.device)}</div>
            {r.since > 0 && (
              <div className="ri-sub" title={new Date(r.since).toLocaleString()}>
                connected {formatRefreshed(now - r.since)}
              </div>
            )}
          </div>
        ))}
        </div>
      </div>
    </div>
  )
}

const VIEWS: [View, string, string][] = [
  ['terminals', 'Terminals', ''],
  ['board', 'Board', ''],
  ['prs', 'Pull requests', ''],
  ['tasks', 'Tasks', ''],
]
/** Notes is a panel over the current view, not a view: its button toggles it. */
const TOOLS: [View | 'notes', string][] = [
  ['costs', 'Costs'],
  ['janitor', 'Janitor'],
  ['notes', 'Notes'],
  ['meetings', 'Meetings'],
  ['workflow', 'Workflow'],
  ['schedules', 'Schedules'],
]
/** A tool shown here: Meetings is the Mac's window only (macOS, never the web). */
const toolOk = (v: View | 'notes') => screenOk(v) && (v !== 'meetings' || meetingsHere())
const ACTIONS: [RailAction, string, string][] = [
  ['broadcast', 'Broadcast', 'Send one message to several sessions'],
  ['standup', 'Standup', "Yesterday's commits, PRs and reports"],
  ['skills', 'Skills', 'Add or remove skills'],
  ['palette', 'Commands', '⌘K'],
]
const viewOf = new Map<string, [View, string, string]>(VIEWS.map((v) => [v[0], v]))
const toolOf = new Map<string, [View | 'notes', string]>(TOOLS.map((t) => [t[0], t]))
const actionOf = new Map<string, [RailAction, string, string]>(ACTIONS.map((a) => [a[0], a]))

/** Pixels the pointer moves before a press on an icon becomes a drag (less is a click). */
const DRAG_PX = 4

interface Drag {
  id: string
  /** How far the pointer moved since the press: the dragged icon follows it. */
  dy: number
  /** Where it lands: before this id (null: the end), so an order synced in mid-drag still holds. */
  before: string | null
  /** The drop line's top, in the rail's box. */
  line: number
}

/** The rail's right-click menu: Reset icon order. */
function RailMenu({ x, y, canReset, onReset, onClose }: { x: number; y: number; canReset: boolean; onReset: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
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
  return (
    <div className="menu rail-menu" ref={ref} style={{ left: x, top: Math.max(4, Math.min(y, window.innerHeight - 48)) }} role="menu" aria-label="Rail">
      <button role="menuitem" autoFocus disabled={!canReset} onClick={() => (onClose(), onReset())}>
        Reset icon order
      </button>
    </div>
  )
}

/**
 * The Command Center rail: views on top, tools, then actions and Settings at the bottom, in the
 * user's order (#170): an icon is dragged, or moved with ⌥↑ / ⌥↓, around the fixed line and spacer.
 */
export function Rail({ view, onView, onAction, needs, prAttention, remote, onRemote, notesOpen, onNotes, meeting, update, order: saved, onOrder }: Props) {
  // The order just picked, drawn until the saved settings carry it (state updates keep coming meanwhile).
  const savedKey = saved.join(' ')
  const [local, setLocal] = useState<{ key: string; order: string[] } | null>(null)
  const order = useMemo(() => (local && local.key === savedKey ? local.order : railOrder(saved)), [local, savedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Once the saved order moved on, the picked one is done: kept, it would come back when the saved
  // order returns to the same value (a reset to [] after a move saved from []).
  useEffect(() => setLocal((l) => (l && l.key !== savedKey ? null : l)), [savedKey])
  const [drag, setDrag] = useState<Drag | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const nav = useRef<HTMLElement>(null)
  const press = useRef<{ id: string; x: number; y: number; pointer: number } | null>(null)
  const live = useRef<Drag | null>(null)
  const boxes = useRef<{ top: number; entries: (RailEntry & { top: number; bottom: number })[] }>({ top: 0, entries: [] })
  // A click that ends a drag (or a cancelled one) is not a click on the icon.
  const swallow = useRef(false)
  const focusAfter = useRef<string | null>(null)

  const shown = (id: string): boolean => {
    if (isRailMark(id)) return true
    if (id === 'record') return !!meeting && canRecord()
    if (toolOf.has(id)) return toolOk(id as View | 'notes')
    if (actionOf.has(id)) return id === 'palette' || screenOk(id as Exclude<RailAction, 'palette'>)
    return screenOk(id as View)
  }
  const hasIcon = (ids: string[]) => ids.some((x) => !isRailMark(x) && shown(x))
  // As before: a line only between two groups that both have an icon here.
  const sepDrawn = () => {
    const i = order.indexOf(RAIL_SEP)
    return hasIcon(order.slice(0, i)) && hasIcon(order.slice(i + 1, order.indexOf(RAIL_SPACER)))
  }
  /** What ⌥↑ / ⌥↓ steps over: a drawn icon, the spacer, the separator only where it is drawn. */
  const stepShown = (id: string) => (id === RAIL_SEP ? sepDrawn() : shown(id))
  const commit = (next: string[]) => {
    if (next.join(' ') === order.join(' ')) return false
    setLocal({ key: savedKey, order: next })
    onOrder(toSaved(next, saved))
    return true
  }
  const end = () => {
    press.current = null
    live.current = null
    setDrag(null)
    // The click a release makes (if any) comes in this same task; a later one (Enter) is real.
    if (swallow.current) setTimeout(() => (swallow.current = false), 0)
  }
  const dragging = !!drag
  useEffect(() => {
    if (!dragging) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      end()
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', end)
    }
  }, [dragging])
  // Moving the focused icon in the DOM drops its focus: give it back after ⌥↑ / ⌥↓.
  useLayoutEffect(() => {
    const id = focusAfter.current
    focusAfter.current = null
    const el = id ? nav.current?.querySelector<HTMLElement>(`[data-rail="${id}"]`) : null
    const b = el?.matches('button') ? el : el?.querySelector('button')
    if (b && document.activeElement !== b) b.focus()
  }, [order])

  const onPointerDown = (e: React.PointerEvent) => {
    swallow.current = false
    const t = e.target as HTMLElement
    const el = t.closest<HTMLElement>('[data-rail]')
    // Only the icons drag, never Record's popout or the remote card drawn beside them.
    if (e.button !== 0 || live.current || !el || t.closest('.rec-pop, .ri-card')) return
    press.current = { id: el.dataset.rail!, x: e.clientX, y: e.clientY, pointer: e.pointerId }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current
    const box = nav.current
    if (!p || !box || p.pointer !== e.pointerId) return
    // A press let go outside the rail before it became a drag: no button is down any more.
    if (!e.buttons) return void end()
    if (!live.current) {
      if (Math.abs(e.clientY - p.y) < DRAG_PX && Math.abs(e.clientX - p.x) < DRAG_PX) return
      const top = box.getBoundingClientRect().top
      const entries = [...box.querySelectorAll<HTMLElement>('[data-rail], [data-rail-mark]')]
        .map((el) => ({ id: el.dataset.rail ?? el.dataset.railMark ?? '', r: el.getBoundingClientRect() }))
        .filter((x) => x.id !== p.id)
        .map(({ id, r }) => ({ id, top: r.top - top, bottom: r.bottom - top, mid: (r.top + r.bottom) / 2 - top }))
      boxes.current = { top, entries }
      box.setPointerCapture(e.pointerId)
      swallow.current = true
    }
    const { top, entries } = boxes.current
    const y = e.clientY - top
    const next = entries.find((x) => x.mid > y)
    const last = entries.at(-1)
    // The line sits in the 4 px gap above the entry it lands before (the spacer's top: the middle group's end).
    const d = { id: p.id, dy: e.clientY - p.y, before: order[dropBefore(order, entries, y)] ?? null, line: next ? next.top - 2 : last ? last.bottom + 2 : 0 }
    live.current = d
    setDrag(d)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = live.current
    end()
    if (!d) return
    if (nav.current?.hasPointerCapture(e.pointerId)) nav.current.releasePointerCapture(e.pointerId)
    const at = d.before === null ? order.length : order.indexOf(d.before)
    if (at >= 0) commit(moveTo(order, d.id, at))
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    const t = e.target as HTMLElement
    const id = t.closest<HTMLElement>('[data-rail]')?.dataset.rail
    if (!id || t.closest('.rec-pop')) return
    e.preventDefault()
    if (commit(moveStep(order, id, e.key === 'ArrowUp' ? -1 : 1, stepShown))) focusAfter.current = id
  }

  /** What every icon carries: its id for the drag, and the lift while it is the one dragged. */
  const lift = (id: string) => ({
    'data-rail': id,
    'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
    style: drag?.id === id ? { transform: `translateY(${drag.dy}px)` } : undefined,
  })
  const liftClass = (id: string) => (drag?.id === id ? ' rail-lift' : '')
  const viewBtn = (v: View, label: string, hint = '', badge = 0, dot: Props['update'] = null) => {
    const name = dot ? `${label} · ${badgeLabel(dot)}` : label
    return (
      <button key={v} {...lift(v)} className={`rb ${view === v ? 'on' : ''}${liftClass(v)}`} data-tip={hint ? `${name}  ${hint}` : name} aria-label={name} aria-current={view === v ? 'page' : undefined} onClick={() => onView(v)}>
        <RailIcon name={v} />
        {badge > 0 && <span className="rb-badge">{badge}</span>}
        {dot && <span className={`rb-dot ${dot}`} aria-hidden="true" />}
      </button>
    )
  }
  const entry = (id: string): ReactNode => {
    if (id === RAIL_SEP) return sepDrawn() ? <div key={id} className="rail-sep" data-rail-mark={id} /> : null
    if (id === RAIL_SPACER)
      return (
        <Fragment key={id}>
          <div className="rail-spacer" data-rail-mark={id} />
          <RemoteIndicator remote={remote} onRemote={onRemote} />
        </Fragment>
      )
    if (!shown(id)) return null
    if (id === 'record')
      return (
        meeting && (
          <div key={id} {...lift(id)} className={`rail-item${liftClass(id)}`}>
            <RecordMeeting {...meeting} />
          </div>
        )
      )
    if (id === 'notes')
      return (
        <button key={id} {...lift(id)} className={`rb ${notesOpen ? 'on' : ''}${liftClass(id)}`} data-tip="Notes" aria-label="Notes" aria-pressed={notesOpen} onClick={onNotes}>
          <RailIcon name="notes" />
        </button>
      )
    const a = actionOf.get(id)
    if (a)
      return (
        <button key={id} {...lift(id)} className={`rb${liftClass(id)}`} data-tip={`${a[1]} · ${a[2]}`} aria-label={a[1]} onClick={() => onAction(a[0])}>
          <RailIcon name={id} />
        </button>
      )
    if (id === 'settings') return viewBtn('settings', 'Settings', '⌘,', 0, update)
    const v = viewOf.get(id) ?? toolOf.get(id)
    if (!v) return null
    return viewBtn(v[0] as View, v[1], v[2] ?? '', id === 'terminals' ? needs : id === 'prs' ? prAttention : 0)
  }
  return (
    <nav
      ref={nav}
      className={`rail${drag ? ' dragging' : menu ? ' menu-open' : ''}`}
      aria-label="Views"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={end}
      onLostPointerCapture={() => live.current && end()}
      onClickCapture={(e) => {
        if (!swallow.current) return
        swallow.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.rec-pop, .ri-card, .rail-menu, input, textarea')) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div className="rail-drag" />
      {order.map(entry)}
      {drag && <div className="rail-drop" style={{ top: drag.line }} aria-hidden="true" />}
      {menu && <RailMenu x={menu.x} y={menu.y} canReset={!isDefaultOrder(order)} onReset={() => commit([...RAIL_DEFAULT])} onClose={closeMenu} />}
    </nav>
  )
}

export type PhoneScreen = 'list' | 'main' | 'master'

interface PhoneProps {
  view: View
  screen: PhoneScreen
  /** A view tab (Tasks, Board, PRs, or one from More). */
  onView: (v: View) => void
  /** Sessions: the session list. */
  onSessions: () => void
  /** Master, when master-agent is on. */
  onMaster?: () => void
  onAction: (a: RailAction) => void
  needs: number
  prAttention: number
  notesOpen: boolean
  onNotes: () => void
}

/** The phone's bottom tab bar (web, narrow window): the rail's views as tabs, the rest under More. */
export function PhoneBar({ view, screen, onView, onSessions, onMaster, onAction, needs, prAttention, notesOpen, onNotes }: PhoneProps) {
  const [more, setMore] = useState(false)
  const main = screen === 'main'
  const tab = (key: string, label: string, icon: string, on: boolean, click: () => void, badge = 0) => (
    <button key={key} className={`pb ${on ? 'on' : ''}`} aria-label={label} aria-current={on ? 'page' : undefined} onClick={() => (setMore(false), click())}>
      <RailIcon name={icon} size={20} />
      {badge > 0 && <span className="rb-badge">{badge}</span>}
      <span className="pb-l">{label}</span>
    </button>
  )
  const tools = [...TOOLS, ['settings', 'Settings'] as [View | 'notes', string]].filter(([v]) => toolOk(v))
  const moreOn = notesOpen || (main && tools.some(([v]) => v === view))
  return (
    <nav className="rail phone-bar" aria-label="Views">
      {tab('sessions', 'Sessions', 'terminals', !notesOpen && (screen === 'list' || (main && view === 'terminals')), onSessions, needs)}
      {(['tasks', 'board', 'prs'] as View[]).filter(screenOk).map((v) =>
        tab(v, v === 'prs' ? 'PRs' : v[0].toUpperCase() + v.slice(1), v, !notesOpen && main && view === v, () => onView(v), v === 'prs' ? prAttention : 0),
      )}
      {onMaster && tab('master', 'Master', 'master', !notesOpen && screen === 'master', onMaster)}
      <button className={`pb ${moreOn || more ? 'on' : ''}`} aria-label="More" aria-expanded={more} onClick={() => setMore(!more)}>
        <RailIcon name="more" size={20} />
        <span className="pb-l">More</span>
      </button>
      {more && (
        <>
          <div className="phone-more-back" onClick={() => setMore(false)} />
          <div className="menu phone-more" role="menu">
            {tools.map(([v, label]) => (
              <button
                key={v}
                role="menuitem"
                className={(v === 'notes' ? notesOpen : main && view === v) ? 'on' : ''}
                onClick={() => (setMore(false), v === 'notes' ? onNotes() : onView(v))}
              >
                <RailIcon name={v} /> {label}
              </button>
            ))}
            <hr />
            {ACTIONS.filter(([a]) => a === 'palette' || screenOk(a)).map(([a, label]) => (
              <button key={a} role="menuitem" onClick={() => (setMore(false), onAction(a))}>
                <RailIcon name={a} /> {label}
              </button>
            ))}
          </div>
        </>
      )}
    </nav>
  )
}
