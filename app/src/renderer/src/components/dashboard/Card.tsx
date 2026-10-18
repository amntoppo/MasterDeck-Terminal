import { memo, type ReactNode } from 'react'
import { relTime } from '@shared/dashboard'

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
  return (
    <section className={`dash-card dash-${id}${className ? ` ${className}` : ''}`} aria-label={title} data-card={id}>
      <header className="dash-ch">
        <h3 className="dash-ct">{title}</h3>
        {count && !loading && (
          <span className="dash-cnt" title={countTip}>
            {count}
          </span>
        )}
        <span className="dash-grow" />
        {link && onLink && (
          <button className="dash-more" onClick={onLink}>
            {link}
          </button>
        )}
      </header>
      <div className="dash-cb">{loading ? <Skeleton /> : empty ? <div className="dash-empty">{empty}</div> : children}</div>
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
