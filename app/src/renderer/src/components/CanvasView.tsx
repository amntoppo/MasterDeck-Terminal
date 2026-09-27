import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { arrange, bounds, CARD_H, CARD_W, fitView, placeNew, zoomAt, type CanvasView as View, type Pos } from '@shared/canvas'
import { MASTER_NAME } from '@shared/derive'
import { formatAgo } from '@shared/format'
import { attentionFor, sessionStatus, type StatusKey } from '@shared/review'
import { ticketLabel } from '@shared/ticket'
import type { AppState, Session } from '@shared/types'
import { load, save, useNow } from '../deck'
import { MiniTerminal } from './MiniTerminal'
import { typeInto } from './TerminalView'

const LAYOUT_KEY = 'canvasLayout'
const VIEW_KEY = 'canvasView'

/** Statuses that want the user: their cards pulse. */
const HOT: StatusKey[] = ['needs-input', 'question', 'blocked', 'ci-failing', 'changes']

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
}

type Drag = { kind: 'pan'; sx: number; sy: number; v: View } | { kind: 'card'; key: string; sx: number; sy: number; p: Pos; moved: boolean }

/**
 * Every session as a live mini terminal on a plane: drag cards anywhere, pan by dragging the
 * background or scrolling, zoom with ⌘/Ctrl + scroll (or a pinch). The mini terminals share their
 * PTY with the Terminals view, so both can be open at once.
 */
export function CanvasView({ state, onOpenSession }: Props) {
  const now = useNow()
  const [showParked, setShowParked] = useState(() => load<boolean>('canvasParked', true))
  useEffect(() => save('canvasParked', showParked), [showParked])
  const sessions = useMemo(
    () => state.sessions.filter((s) => s.name !== MASTER_NAME && s.state !== 'done' && (showParked || s.state !== 'suspended')),
    [state.sessions, showParked],
  )
  const keys = useMemo(() => sessions.map((s) => s.key), [sessions])

  const [placed, setPlaced] = useState<Record<string, Pos>>(() => load(LAYOUT_KEY, {}))
  const layout = useMemo(() => placeNew(placed, keys), [placed, keys])
  // Remember where new cards landed, so they stay put when others come and go.
  useEffect(() => {
    if (keys.some((k) => !placed[k])) setPlaced((cur) => ({ ...cur, ...layout }))
  }, [keys, placed, layout])
  useEffect(() => save(LAYOUT_KEY, placed), [placed])

  const [view, setView] = useState<View>(() => load<View | null>(VIEW_KEY, null) ?? { x: 40, y: 40, z: 0.8 })
  useEffect(() => save(VIEW_KEY, view), [view])
  const [front, setFront] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const port = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [panning, setPanning] = useState(false)

  const fit = useCallback(() => {
    const el = port.current
    if (el) setView(fitView(keys.map((k) => layout[k]), el.clientWidth, el.clientHeight))
  }, [keys, layout])

  // First visit: show everything.
  useEffect(() => {
    if (load<View | null>(VIEW_KEY, null) === null && keys.length) fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const zoomBy = useCallback((factor: number, px?: number, py?: number) => {
    const el = port.current
    setView((v) => zoomAt(v, factor, px ?? (el?.clientWidth ?? 0) / 2, py ?? (el?.clientHeight ?? 0) / 2))
  }, [])

  // Wheel: scroll pans; ⌘/Ctrl + scroll and trackpad pinches (ctrlKey) zoom at the pointer.
  useEffect(() => {
    const el = port.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('input, .ccard-send')) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        setView((v) => zoomAt(v, Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0025)), e.clientX - r.left, e.clientY - r.top))
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button, input, select, .mini-over button')) return
    const card = target.closest<HTMLElement>('[data-card]')
    if (card) {
      const key = card.dataset.card!
      drag.current = { kind: 'card', key, sx: e.clientX, sy: e.clientY, p: layout[key], moved: false }
      setFront((cur) => [...cur.filter((k) => k !== key), key])
      setSelected(key)
    } else {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: view }
      setPanning(true)
      setSelected(null)
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (d.kind === 'pan') setView({ ...d.v, x: d.v.x + dx, y: d.v.y + dy })
    else {
      if (!d.moved && Math.hypot(dx, dy) < 3) return
      d.moved = true
      setPlaced((cur) => ({ ...cur, [d.key]: { x: Math.round(d.p.x + dx / view.z), y: Math.round(d.p.y + dy / view.z) } }))
    }
  }
  const onPointerUp = () => {
    drag.current = null
    setPanning(false)
  }

  const statusOf = (s: Session) => sessionStatus(s, state.prStage[s.key], attentionFor(s, state.proposals), state.manualStatus[s.key])
  const statuses = sessions.map(statusOf)
  const counts = {
    working: statuses.filter((x) => x.key === 'working').length,
    hot: statuses.filter((x) => HOT.includes(x.key)).length,
  }
  const order = (k: string) => {
    const i = front.indexOf(k)
    return i < 0 ? 1 : i + 2
  }

  return (
    <section className="board-view canvas-view">
      <header className="board-head">
        <h2>Canvas</h2>
        <span className="muted">
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
          {counts.working > 0 && <> · <span className="ok">{counts.working} working</span></>}
          {counts.hot > 0 && <> · <span className="bad">{counts.hot} need you</span></>}
        </span>
        <span style={{ flex: 1 }} />
        <label className="canvas-check" title="Parked sessions show without a terminal; attaching resumes them">
          <input type="checkbox" checked={showParked} onChange={(e) => setShowParked(e.target.checked)} /> Parked
        </label>
        <button className="btn" onClick={() => setPlaced((cur) => ({ ...cur, ...arrange(keys) }))} title="Lay the cards out in a grid">
          Arrange
        </button>
        <div className="zoom-group">
          <button className="btn" onClick={() => zoomBy(1 / 1.25)} title="Zoom out (⌘ + scroll)">
            −
          </button>
          <button className="btn zoom-pct" onClick={() => zoomBy(1 / view.z)} title="Back to 100%">
            {Math.round(view.z * 100)}%
          </button>
          <button className="btn" onClick={() => zoomBy(1.25)} title="Zoom in (⌘ + scroll)">
            +
          </button>
        </div>
        <button className="btn" onClick={fit} title="Zoom to show every card">
          Fit
        </button>
      </header>
      <div
        className={`canvas-port ${panning ? 'panning' : ''}`}
        ref={port}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${28 * view.z}px ${28 * view.z}px` }}
      >
        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          {sessions.map((s, i) => (
            <SessionCard
              key={s.key}
              s={s}
              state={state}
              status={statuses[i]}
              pos={layout[s.key]}
              z={order(s.key)}
              selected={selected === s.key}
              now={now}
              onOpen={() => onOpenSession(s)}
            />
          ))}
        </div>
        {sessions.length === 0 && (
          <div className="welcome canvas-empty">
            <h2>No sessions running</h2>
            <div>Start one from the board, or from a ticket in ⌘K. Each session shows here as a live mini terminal.</div>
          </div>
        )}
        {sessions.length > 0 && (
          <Minimap
            cards={sessions.map((s, i) => ({ key: s.key, pos: layout[s.key], status: statuses[i].key }))}
            view={view}
            port={port}
            onJump={(x, y) => {
              const el = port.current
              if (el) setView((v) => ({ ...v, x: el.clientWidth / 2 - x * v.z, y: el.clientHeight / 2 - y * v.z }))
            }}
          />
        )}
        <div className="canvas-hint">Drag cards to move · drag the background or scroll to pan · ⌘ + scroll to zoom · double-click a card to open it</div>
      </div>
    </section>
  )
}

function SessionCard({
  s,
  state,
  status,
  pos,
  z,
  selected,
  now,
  onOpen,
}: {
  s: Session
  state: AppState
  status: ReturnType<typeof sessionStatus>
  pos: Pos
  z: number
  selected: boolean
  now: number
  onOpen: () => void
}) {
  const [attach, setAttach] = useState(false)
  const [reply, setReply] = useState('')
  const tail = state.tails[s.sessionId]
  const paneId = `s:${s.key}`
  const parked = s.state === 'suspended'
  const canAttach = s.kind === 'background' && !!s.bgId
  // Running sessions attach right away; a parked one only on request (attaching resumes it).
  const spec = canAttach && (!parked || attach) ? { kind: 'attach' as const, bgId: s.bgId! } : null
  const hot = HOT.includes(status.key)
  const lastAt = tail?.lastActivityAt ?? s.startedAt
  const send = () => {
    const text = reply.trim()
    if (!text || !spec) return
    typeInto(paneId, text)
    setReply('')
  }

  return (
    <div
      className={`ccard st-${status.key} ${hot ? 'hot' : ''} ${selected ? 'selected' : ''}`}
      data-card={s.key}
      style={{ left: pos.x, top: pos.y, width: CARD_W, height: CARD_H, zIndex: z }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('input, button')) onOpen()
      }}
      title={`${s.name}\n${s.cwd}${status.why ? `\n${status.text}: ${status.why}` : ''}`}
    >
      <div className="ccard-head">
        <span className={`dot st-${status.key}`} />
        <span className="ccard-name">{s.name}</span>
        {s.issue !== null && <span className="ccard-num">{ticketLabel(s.issueRepo, s.issue)}</span>}
        <span className="grow" />
        <span className={`ccard-status st-${status.key}`}>{status.text}</span>
        <button className="icon-btn" onClick={onOpen} title="Open in Terminals">
          ↗
        </button>
      </div>
      <div className="ccard-body">
        {canAttach && spec ? (
          <MiniTerminal paneId={paneId} spec={spec} />
        ) : canAttach ? (
          <MiniTerminal
            paneId={paneId}
            spec={null}
            placeholder={
              <>
                <div>Parked. Attaching resumes it.</div>
                <button className="btn" onClick={() => setAttach(true)}>
                  Attach
                </button>
              </>
            }
          />
        ) : (
          <div className="mini-term">
            <div className="mini-over">
              <div>Runs in another terminal (pid {s.pid ?? '?'}); it can't be shown here.</div>
            </div>
          </div>
        )}
        {hot && <div className="ccard-flag">{status.key === 'needs-input' ? 'Waiting on you' : status.text}</div>}
      </div>
      <div className="ccard-foot">
        {spec ? (
          <input
            className="ccard-send"
            value={reply}
            placeholder={`Send to ${s.name}… (Enter)`}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send()
              e.stopPropagation()
            }}
          />
        ) : (
          <span className="grow" />
        )}
        <span className="ccard-meta">
          {tail?.lastTool && <span className="mono">{tail.lastTool}</span>}
          {lastAt ? ` ${formatAgo(now - lastAt)}` : ''}
        </span>
      </div>
    </div>
  )
}

const MAP_W = 180
const MAP_H = 120

/** Where every card is, and the part of the canvas on screen; click or drag to move there. */
function Minimap({
  cards,
  view,
  port,
  onJump,
}: {
  cards: { key: string; pos: Pos; status: StatusKey }[]
  view: View
  port: React.RefObject<HTMLDivElement | null>
  onJump: (x: number, y: number) => void
}) {
  const el = port.current
  const vw = (el?.clientWidth ?? 0) / view.z
  const vh = (el?.clientHeight ?? 0) / view.z
  const vx = -view.x / view.z
  const vy = -view.y / view.z
  const b = bounds([...cards.map((c) => c.pos), { x: vx, y: vy }, { x: vx + vw - CARD_W, y: vy + vh - CARD_H }])
  const pad = 200
  const k = Math.min(MAP_W / (b.w + 2 * pad), MAP_H / (b.h + 2 * pad))
  const ox = (MAP_W - (b.w + 2 * pad) * k) / 2 - (b.x - pad) * k
  const oy = (MAP_H - (b.h + 2 * pad) * k) / 2 - (b.y - pad) * k
  const jump = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onJump((e.clientX - r.left - ox) / k, (e.clientY - r.top - oy) / k)
  }
  return (
    <svg
      className="minimap"
      width={MAP_W}
      height={MAP_H}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        jump(e)
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) {
          e.stopPropagation()
          jump(e)
        }
      }}
    >
      {cards.map((c) => (
        <rect key={c.key} className={`mm-card st-${c.status}`} x={ox + c.pos.x * k} y={oy + c.pos.y * k} width={CARD_W * k} height={CARD_H * k} rx={2} />
      ))}
      <rect className="mm-view" x={ox + vx * k} y={oy + vy * k} width={vw * k} height={vh * k} rx={2} />
    </svg>
  )
}
