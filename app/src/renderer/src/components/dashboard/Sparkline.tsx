import { memo } from 'react'

const W = 200
const H = 46
const PAD = 4

/**
 * A small line chart (#183): `values` left to right (null: no point there), an optional dashed
 * `ideal` line under it, and a dot on the last point. Scales to its box; the label says in words
 * what it shows, for screen readers and as its tooltip.
 */
export const Sparkline = memo(function Sparkline({ values, ideal, label }: { values: (number | null)[]; ideal?: number[]; label: string }) {
  const n = Math.max(values.length, ideal?.length ?? 0)
  const max = Math.max(1, ...values.map((v) => v ?? 0), ...(ideal ?? []))
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => PAD + (1 - v / max) * (H - 2 * PAD)
  const pts = values.flatMap((v, i) => (v === null ? [] : [[x(i), y(v)] as const]))
  const line = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <div className="dash-spark-box">
      <svg className="dash-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <title>{label}</title>
        {ideal && ideal.length > 1 && (
          <polyline
            points={ideal.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="var(--line-3)"
            strokeWidth={1.2}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {pts.length > 1 && <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* The dot is drawn over the stretched SVG, so it stays round. */}
      {last && <span className="dash-spark-dot" aria-hidden="true" style={{ left: `${(last[0] / W) * 100}%`, top: `${(last[1] / H) * 100}%` }} />}
    </div>
  )
})
