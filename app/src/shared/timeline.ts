/**
 * The Costs view's time filter (issue #88): its presets, a custom range, and the time buckets that
 * costs and tokens are kept in. Everything is local time: "Today" starts at the Mac's midnight.
 *
 * Costs and tokens are kept per local clock hour (`YYYY-MM-DDTHH`). Records from before #88, and
 * cost hours older than a month (`pruneBook`), are per local day (`YYYY-MM-DD`). A range that cuts
 * through a bucket gets the bucket's share by time: exact on hour and day boundaries (every preset
 * but Last 1/5/12 hours), an even spread within the clock hour otherwise.
 */

const HOUR = 3_600_000
const p2 = (n: number) => String(n).padStart(2, '0')

/** The local clock hour of `t`, as a bucket key. */
export function hourOf(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}`
}

const BUCKET = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/

/** [start, end) of a bucket in epoch ms; null for anything else (the baseline). */
export function bucketSpan(key: string): [number, number] | null {
  const m = BUCKET.exec(key)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  if (m[4] === undefined) return [new Date(y, mo, d).getTime(), new Date(y, mo, d + 1).getTime()]
  const h = Number(m[4])
  return [new Date(y, mo, d, h).getTime(), new Date(y, mo, d, h + 1).getTime()]
}

/**
 * How much of a bucket falls in [from, to): 0 to 1. The bucket that is still running only counts
 * the part that has happened, so a quarter past three puts all of 15:00's spend in "the last hour".
 */
export function bucketShare(key: string, from: number, to: number, now: number): number {
  const span = bucketSpan(key)
  if (!span) return 0
  const [s, e0] = span
  const e = now > s && now < e0 ? now : e0
  if (from <= s && to >= e) return 1
  const overlap = Math.min(e, to) - Math.max(s, from)
  return overlap > 0 ? overlap / (e - s) : 0
}

export const PRESETS = ['1h', '5h', '12h', 'today', 'yesterday', '7d', '30d', 'all', 'custom'] as const
export type Preset = (typeof PRESETS)[number]

export const PRESET_LABEL: Record<Preset, string> = {
  '1h': 'Last 1 hour',
  '5h': 'Last 5 hours',
  '12h': 'Last 12 hours',
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
  custom: 'Custom…',
}

/** What the filter is set to. A custom range is [from, to) in epoch ms. */
export type RangeChoice = { preset: Exclude<Preset, 'custom'> } | { preset: 'custom'; from: number; to: number }

export const DEFAULT_RANGE: RangeChoice = { preset: '7d' }

/** A saved choice, checked: anything unreadable is the default. */
export function parseRange(raw: unknown): RangeChoice {
  if (!raw || typeof raw !== 'object') return DEFAULT_RANGE
  const r = raw as Record<string, unknown>
  if (r.preset === 'custom') return Number.isFinite(r.from) && Number.isFinite(r.to) && (r.to as number) > (r.from as number) ? { preset: 'custom', from: r.from as number, to: r.to as number } : DEFAULT_RANGE
  return (PRESETS as readonly unknown[]).includes(r.preset) ? { preset: r.preset as Exclude<Preset, 'custom'> } : DEFAULT_RANGE
}

/** Local midnight of the day `t` is in, moved by `days`. */
export function midnight(t: number, days = 0): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime()
}

/** [from, to) in epoch ms. "Last 7 days" is today and the six days before it, as the old filter had it. */
export function resolveRange(c: RangeChoice, now: number): { from: number; to: number } {
  switch (c.preset) {
    case '1h':
      return { from: now - HOUR, to: now }
    case '5h':
      return { from: now - 5 * HOUR, to: now }
    case '12h':
      return { from: now - 12 * HOUR, to: now }
    case 'today':
      return { from: midnight(now), to: now }
    case 'yesterday':
      return { from: midnight(now, -1), to: midnight(now) }
    case '7d':
      return { from: midnight(now, -6), to: now }
    case '30d':
      return { from: midnight(now, -29), to: now }
    case 'all':
      return { from: 0, to: now }
    case 'custom':
      return { from: c.from, to: c.to }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dateText(t: number, now: number): string {
  const d = new Date(t)
  const y = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${y}`
}

const clock = (t: number) => {
  const d = new Date(t)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** What the filter shows: the preset's name, or a custom range ("3 Oct – 9 Oct", with times when it has any). */
export function rangeLabel(c: RangeChoice, now: number): string {
  if (c.preset !== 'custom') return PRESET_LABEL[c.preset]
  // A range from midnight to midnight is whole days: its last day is the one before `to`.
  if (c.from === midnight(c.from) && c.to === midnight(c.to)) {
    const a = dateText(c.from, now)
    const b = dateText(c.to - 1, now)
    return a === b ? a : `${a} – ${b}`
  }
  const sameDay = midnight(c.from) === midnight(c.to - 1)
  return `${dateText(c.from, now)} ${clock(c.from)} – ${sameDay ? '' : `${dateText(c.to, now)} `}${clock(c.to)}`
}

/** `<input type="datetime-local">`'s value for `t` (local time, to the minute). */
export function toInputValue(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${clock(t)}`
}

/** The epoch ms of a datetime-local value; null when empty or unreadable. */
export function fromInputValue(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v)
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * A custom range from the picker's two values, or what is wrong with them. The end is the last
 * minute that counts, so 3 Oct 00:00 to 9 Oct 23:59 is the whole of both days.
 */
export function customRange(fromValue: string, toValue: string): { range: RangeChoice } | { error: string } {
  const from = fromInputValue(fromValue)
  const end = fromInputValue(toValue)
  if (from === null || end === null) return { error: 'Pick a start and an end.' }
  if (end < from) return { error: 'The end is before the start.' }
  return { range: { preset: 'custom', from, to: end + 60_000 } }
}

/** The picker's values for a range (`to` back to its last minute). */
export function customValues(r: { from: number; to: number }): { from: string; to: string } {
  return { from: toInputValue(r.from), to: toInputValue(r.to - 60_000) }
}

export interface Bar {
  start: number
  end: number
  /** Under the bar: the hour, the day of the month, or the week's or month's start. */
  label: string
  /** On hover. */
  title: string
  /** It holds `now`. */
  current: boolean
}

/**
 * The chart's bars for [from, to): hours up to two days, days up to two months, then weeks (from
 * Monday) up to about a year, then months. The first and last bar can stick out of the range; their
 * values only count the part inside it.
 */
export function chartBars(from: number, to: number, now: number): { unit: 'hour' | 'day' | 'week' | 'month'; bars: Bar[] } {
  const span = to - from
  const unit = span <= 48 * HOUR ? 'hour' : span <= 62 * 86_400_000 ? 'day' : span <= 62 * 7 * 86_400_000 ? 'week' : 'month'
  const d = new Date(from)
  let t =
    unit === 'hour'
      ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
      : unit === 'day'
        ? midnight(from)
        : unit === 'week'
          ? midnight(from, -((d.getDay() + 6) % 7))
          : new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const bars: Bar[] = []
  while (t < to && bars.length < 400) {
    const s = new Date(t)
    const end =
      unit === 'hour'
        ? new Date(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours() + 1).getTime()
        : unit === 'day'
          ? midnight(t, 1)
          : unit === 'week'
            ? midnight(t, 7)
            : new Date(s.getFullYear(), s.getMonth() + 1, 1).getTime()
    const label = unit === 'hour' ? p2(s.getHours()) : unit === 'day' ? p2(s.getDate()) : unit === 'week' ? dateText(t, now) : MONTHS[s.getMonth()]
    const title =
      unit === 'hour' ? `${dateText(t, now)} ${clock(t)}–${clock(end)}` : unit === 'day' ? dateText(t, now) : unit === 'week' ? `Week of ${dateText(t, now)}` : `${MONTHS[s.getMonth()]} ${s.getFullYear()}`
    bars.push({ start: t, end, label, title, current: t <= now && now < end })
    t = end
  }
  return { unit, bars }
}
