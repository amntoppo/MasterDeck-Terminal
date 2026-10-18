import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { cleanLayout, dropNearest, dropTo, isDefault, layoutOrder, moveStep, moveTo, setHidden, toSaved, type CardId, type CardRect, type Drop, type Layout } from '@shared/dashboardLayout'
import { load, save } from '../../deck'
import type { Customise, CustomiseApi } from './Card'

/** A press becomes a drag after this many pixels, as on the rail. */
const DRAG_PX = 4
/** Half the grid's gap: the drop marker sits in the middle of it. */
const HALF_GAP = 8

interface Drag {
  id: CardId
  pointer: number
  x: number
  y: number
  handle: HTMLElement
  card: HTMLElement | null
  /** The other shown cards' boxes and the grid's, taken when the drag starts. */
  rects: CardRect[]
  grid: DOMRect | null
  across: boolean
  live: boolean
  drop: Drop | null
  cleanup: () => void
}

const overlapY = (a: CardRect, b: CardRect) => a.top < b.top + b.height && b.top < a.top + a.height

/** The click a release makes comes in this same task; a later one is real. */
function swallowClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', stop, true)
  setTimeout(() => window.removeEventListener('click', stop, true), 0)
}

/**
 * Customise mode (#183): the saved layout, and moving and hiding cards. A drag works on the DOM
 * alone (the card's transform and the marker's box), so a pointer move draws no card again; only
 * the drop commits a new order. Modelled on the rail's drag (#170).
 */
export function useCustomise(key: string) {
  const [layout, setLayoutState] = useState<Layout>(() => cleanLayout(load<unknown>(key, null)))
  const [on, setOnState] = useState(false)
  const setLayout = useCallback(
    (l: Layout) => {
      setLayoutState(l)
      save(key, toSaved(l))
    },
    [key],
  )
  const full = useMemo(() => layoutOrder(layout), [layout])
  const shown = useMemo(() => full.filter((id) => !layout.hidden.includes(id)), [full, layout.hidden])
  const hidden = useMemo(() => full.filter((id) => layout.hidden.includes(id)), [full, layout.hidden])
  const latest = useRef({ layout, full })
  latest.current = { layout, full }

  const gridRef = useRef<HTMLDivElement>(null)
  const markerRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const focusAfter = useRef<{ id: CardId; ctl: string | null } | null>(null)

  const commit = useCallback(
    (order: CardId[]) => {
      const cur = latest.current
      if (order.join(' ') === cur.full.join(' ')) return false
      setLayout({ order, hidden: cur.layout.hidden })
      return true
    },
    [setLayout],
  )

  const cancel = useCallback(() => {
    const d = drag.current
    if (!d) return
    drag.current = null
    d.cleanup()
    if (d.handle.hasPointerCapture?.(d.pointer)) d.handle.releasePointerCapture(d.pointer)
    if (d.card) {
      d.card.style.transform = ''
      d.card.classList.remove('dash-lift')
    }
    if (markerRef.current) markerRef.current.style.display = 'none'
    if (d.live) swallowClick()
  }, [])

  const place = (d: Drag) => {
    const m = markerRef.current
    const drop = d.drop
    if (!m || !drop || !d.grid) return
    const r = d.rects[drop.index]
    const g = d.grid
    m.style.display = 'block'
    if (d.across) {
      const x = (drop.after ? r.left + r.width + HALF_GAP : r.left - HALF_GAP) - g.left
      Object.assign(m.style, { left: `${x - 1.5}px`, top: `${r.top - g.top}px`, width: '3px', height: `${r.height}px` })
    } else {
      const y = (drop.after ? r.top + r.height + HALF_GAP : r.top - HALF_GAP) - g.top
      Object.assign(m.style, { left: `${r.left - g.left}px`, top: `${y - 1.5}px`, width: `${r.width}px`, height: '3px' })
    }
  }

  const api = useMemo<CustomiseApi>(
    () => ({
      press: (id: CardId, e: ReactPointerEvent<HTMLElement>) => {
        if (e.button !== 0 || drag.current) return
        e.preventDefault()
        const d: Drag = {
          id,
          pointer: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          handle: e.currentTarget,
          card: e.currentTarget.closest<HTMLElement>('.dash-card'),
          rects: [],
          grid: null,
          across: false,
          live: false,
          drop: null,
          cleanup: () => {},
        }
        const move = (ev: PointerEvent) => {
          if (ev.pointerId !== d.pointer || drag.current !== d) return
          const dx = ev.clientX - d.x
          const dy = ev.clientY - d.y
          if (!d.live) {
            if (Math.abs(dx) < DRAG_PX && Math.abs(dy) < DRAG_PX) return
            // Let go outside the window before it became a drag: no button is down any more.
            if (!ev.buttons) return cancel()
            const grid = gridRef.current
            d.grid = grid?.getBoundingClientRect() ?? null
            d.rects = [...(grid?.querySelectorAll<HTMLElement>('[data-card]') ?? [])]
              .filter((el) => el.dataset.card !== id)
              .map((el) => {
                const r = el.getBoundingClientRect()
                return { id: el.dataset.card as CardId, left: r.left, top: r.top, width: r.width, height: r.height }
              })
            d.across = d.rects.some((a, i) => d.rects.some((b, j) => i < j && overlapY(a, b)))
            d.live = true
            try {
              d.handle.setPointerCapture(d.pointer)
            } catch {
              // the pointer is gone already; the move still draws, the release ends it
            }
            d.card?.classList.add('dash-lift')
          }
          if (d.card) d.card.style.transform = `translate(${dx}px, ${dy}px)`
          d.drop = dropNearest(d.rects, ev.clientX, ev.clientY)
          place(d)
        }
        const up = (ev: PointerEvent) => {
          if (ev.pointerId !== d.pointer || drag.current !== d) return
          const { live, drop } = d
          cancel()
          if (live && drop) {
            const order = latest.current.full
            commit(moveTo(order, id, dropTo(order, drop)))
          }
        }
        const lost = () => drag.current === d && cancel()
        const cancelEv = (ev: PointerEvent) => ev.pointerId === d.pointer && lost()
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', cancelEv)
        window.addEventListener('blur', lost)
        d.handle.addEventListener('lostpointercapture', lost)
        d.cleanup = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', cancelEv)
          window.removeEventListener('blur', lost)
          d.handle.removeEventListener('lostpointercapture', lost)
        }
        drag.current = d
      },
      step: (id: CardId, dir: -1 | 1) => {
        const { layout: l, full: order } = latest.current
        const ctl = (document.activeElement as HTMLElement | null)?.closest(`[data-card="${id}"]`) ? ((document.activeElement as HTMLElement).dataset.ctl ?? null) : null
        if (commit(moveStep(order, id, dir, (x) => !l.hidden.includes(x)))) focusAfter.current = { id, ctl }
      },
      hide: (id: CardId) => setLayout(setHidden(latest.current.layout, id, true)),
    }),
    [cancel, commit, setLayout],
  )

  // Moving the focused card in the DOM drops its focus: give it back, to the same button if it had one.
  useLayoutEffect(() => {
    const f = focusAfter.current
    focusAfter.current = null
    const card = f ? gridRef.current?.querySelector<HTMLElement>(`[data-card="${f.id}"]`) : null
    if (!card) return
    const ctl = f?.ctl ? card.querySelector<HTMLButtonElement>(`[data-ctl="${f.ctl}"]`) : null
    ;(ctl && !ctl.disabled ? ctl : card).focus()
  }, [layout])

  const setOn = useCallback(
    (v: boolean) => {
      if (!v) cancel()
      setOnState(v)
    },
    [cancel],
  )
  // Esc cancels a drag first, then leaves Customise mode.
  useEffect(() => {
    if (!on) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (drag.current) cancel()
      else setOn(false)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [on, cancel, setOn])
  useEffect(() => cancel, [cancel])

  /** ⌥ and an arrow on a focused card (or a control in its header). */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!on || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')?.dataset.card as CardId | undefined
      if (!dir || !id) return
      e.preventDefault()
      api.step(id, dir)
    },
    [on, api],
  )

  const ctx = useMemo<Customise>(() => ({ on, order: shown, api }), [on, shown, api])
  return {
    on,
    setOn,
    ctx,
    shown,
    hidden,
    canReset: !isDefault(layout),
    reset: () => setLayout({ order: [], hidden: [] }),
    show: (id: CardId) => setLayout(setHidden(layout, id, false)),
    gridRef,
    markerRef,
    onKeyDown,
  }
}
