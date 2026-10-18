/**
 * The left rail's order (#170): one list of rail ids with two marks that never move, the line
 * between views and tools and the spacer above the bottom group (the Remote indicator sits right
 * after it). Icons move around the marks; hidden ones keep their place in the list.
 */

export const RAIL_SEP = 'separator'
export const RAIL_SPACER = 'spacer'
export const RAIL_MARKS: readonly string[] = [RAIL_SEP, RAIL_SPACER]

export const RAIL_DEFAULT: readonly string[] = [
  'terminals',
  'board',
  'prs',
  'tasks',
  RAIL_SEP,
  'costs',
  'janitor',
  'notes',
  'meetings',
  'workflow',
  'schedules',
  'record',
  RAIL_SPACER,
  'broadcast',
  'standup',
  'skills',
  'palette',
  'settings',
]

/** At most this many ids are kept in Settings. */
export const RAIL_ORDER_MAX = 64

export const isRailMark = (id: string) => RAIL_MARKS.includes(id)

/**
 * The saved order as Settings keeps it: strings only, no repeats, at most RAIL_ORDER_MAX. Ids this
 * version does not know stay (a newer version's icon survives a downgrade); `railOrder` skips them.
 */
export function cleanRailOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || !v || v.length > 40 || out.includes(v)) continue
    out.push(v)
    if (out.length >= RAIL_ORDER_MAX) break
  }
  return out
}

/**
 * The order to draw: the saved one without unknown ids, and every default id it lacks (an icon
 * added in a later version) after the id before it in the default, else first. Empty, or marks out
 * of order (a hand-edited file), is the default.
 */
export function railOrder(saved: readonly string[]): string[] {
  const out = cleanRailOrder(saved).filter((id) => RAIL_DEFAULT.includes(id))
  RAIL_DEFAULT.forEach((id, i) => {
    if (out.includes(id)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(RAIL_DEFAULT[j])
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, id)
  })
  return out.indexOf(RAIL_SEP) < out.indexOf(RAIL_SPACER) ? out : [...RAIL_DEFAULT]
}

export const isDefaultOrder = (order: readonly string[]) => {
  const o = railOrder(order)
  return o.length === RAIL_DEFAULT.length && o.every((id, i) => id === RAIL_DEFAULT[i])
}

/**
 * What Settings stores for a drawn order: `[]` for the default, so later defaults apply in full.
 * Ids of `saved` this version does not know go back in after the id they followed there (else
 * first), so a newer version's icons keep their place through a reorder made after a downgrade.
 */
export function toSaved(order: readonly string[], saved: readonly string[] = []): string[] {
  if (isDefaultOrder(order)) return []
  const out = [...order]
  const prev = cleanRailOrder(saved)
  prev.forEach((id, i) => {
    if (RAIL_DEFAULT.includes(id) || out.includes(id)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(prev[j])
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, id)
  })
  return out
}

/** `order` with `id` moved to just before index `before` (`order.length`: the end). Marks never move. */
export function moveTo(order: readonly string[], id: string, before: number): string[] {
  const from = order.indexOf(id)
  if (from < 0 || isRailMark(id)) return [...order]
  const out = order.filter((_, i) => i !== from)
  const at = Math.max(0, Math.min(out.length, before > from ? before - 1 : before))
  out.splice(at, 0, id)
  return out
}

/**
 * ⌥↑ / ⌥↓: `id` moved one step past the next drawn entry above or below it, an icon or a mark (so a
 * step at a group's edge crosses into the next group). What `shown` says is not drawn, an icon or
 * a mark (the separator when a group has no icon here), is passed over.
 */
export function moveStep(order: readonly string[], id: string, dir: -1 | 1, shown: (id: string) => boolean): string[] {
  const from = order.indexOf(id)
  if (from < 0 || isRailMark(id)) return [...order]
  for (let j = from + dir; j >= 0 && j < order.length; j += dir) {
    if (shown(order[j])) return moveTo(order, id, dir > 0 ? j + 1 : j)
  }
  return [...order]
}

/** A drawn entry of the rail (an icon or a mark), with the middle of its box on screen. */
export interface RailEntry {
  id: string
  mid: number
}

/**
 * Where a dragged icon lands, as an index in `order`: before the first drawn entry (in order, the
 * dragged one left out) whose middle is below the pointer, else at the end.
 */
export function dropBefore(order: readonly string[], entries: readonly RailEntry[], y: number): number {
  const e = entries.find((x) => x.mid > y)
  const i = e ? order.indexOf(e.id) : -1
  return i >= 0 ? i : order.length
}
