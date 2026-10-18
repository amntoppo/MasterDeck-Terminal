import { createContext, memo, useContext, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { relTime } from '@shared/dashboard'
import type { CardId } from '@shared/dashboardLayout'

/** What Customise mode does to a card, from DashboardView. Stable while nothing about the layout changes. */
export interface CustomiseApi {
  /** A press on the card's handle: it becomes a drag after 4 px. */
  press(id: CardId, e: ReactPointerEvent<HTMLElement>): void
  /** One place earlier or later among the shown cards. */
  step(id: CardId, dir: -1 | 1): void
  hide(id: CardId): void
}

export interface Customise {
  on: boolean
  /** The shown cards in order, for the ← → buttons at either end. */
  order: readonly CardId[]
  api: CustomiseApi | null
}

/**
 * Read by the card's frame only: switching Customise on draws the frames again, while the bodies
 * (the same elements) are left alone.
 */
export const CustomiseCtx = createContext<Customise>({ on: false, order: [], api: null })

/** A past time in words. `now` is rounded down to the minute, so a time just after it is "just now", not "in a moment". */
export const ago = (at: number, now: number) => relTime(Math.min(at, now), now)

/**
 * One Dashboard card's frame (#183): a title, a count in words with what it counts as its tooltip,
 * a "… →" link to the view it sums up, then the body, a static skeleton while its data is not in,
 * or a sentence when there is nothing to show.
 */
export const Card = memo(function Card({
  id,
  title,
  count,
  countTip,
  link,
  onLink,
  loading,
  empty,
  className,
  children,
}: {
  id: string
  title: string
  count?: string | null
  countTip?: string
  link?: string
  onLink?: () => void
  loading?: boolean
  /** A sentence instead of the body; null or absent: the body. */
  empty?: string | null
  className?: string
  children?: ReactNode
}) {
  const c = useContext(CustomiseCtx)
  const cid = id as CardId
  const at = c.order.indexOf(cid)
  const tools = c.on && c.api && at >= 0
  return (
    <section
      className={`dash-card dash-${id}${className ? ` ${className}` : ''}${tools ? ' dash-cust' : ''}`}
      aria-label={title}
      data-card={id}
      tabIndex={tools ? 0 : undefined}
      aria-keyshortcuts={tools ? 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : undefined}
    >
      <header className="dash-ch">
        {tools && (
          <button className="dash-handle" data-ctl="handle" aria-label={`Move ${title}: drag, or press Alt and an arrow`} title="Drag to move" onPointerDown={(e) => c.api!.press(cid, e)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
            </svg>
          </button>
        )}
        <h3 className="dash-ct">{title}</h3>
        {count && !loading && (
          <span className="dash-cnt" title={countTip}>
            {count}
          </span>
        )}
        <span className="dash-grow" />
        {tools ? (
          <span className="dash-cust-tools">
            <button className="dash-icon" data-ctl="left" aria-label={`Move ${title} earlier`} title="Move earlier (⌥←)" disabled={at === 0} onClick={() => c.api!.step(cid, -1)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
            </button>
            <button className="dash-icon" data-ctl="right" aria-label={`Move ${title} later`} title="Move later (⌥→)" disabled={at === c.order.length - 1} onClick={() => c.api!.step(cid, 1)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            </button>
            <button className="dash-icon" data-ctl="hide" aria-label={`Hide ${title}`} title="Hide" onClick={() => c.api!.hide(cid)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
            </button>
          </span>
        ) : (
          link &&
          onLink && (
            <button className="dash-more" onClick={onLink}>
              {link}
            </button>
          )
        )}
      </header>
      {/* While customising, the rows do not navigate: a click is never a drag, nor a drag a click. */}
      <div className="dash-cb" inert={c.on}>
        {loading ? <Skeleton /> : empty ? <div className="dash-empty">{empty}</div> : children}
      </div>
    </section>
  )
})

/** Grey blocks, no animation (#160). */
export function Skeleton({ rows = 4 }: { rows?: number }) {
  const widths = ['80%', '60%', '72%', '45%', '66%']
  return (
    <div className="dash-sk-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="dash-sk" style={{ width: widths[i % widths.length] }} />
      ))}
    </div>
  )
}
