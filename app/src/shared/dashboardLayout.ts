/**
 * The Dashboard's card layout (#183): the order of its cards and which are hidden, saved per
 * device. Needs attention is fixed at the top and is not in the layout. Hidden cards keep their
 * place in `order`, so showing one again puts it back where it was. The rail's order
 * (`railOrder.ts`) works the same way; the two share no code (different ids, no marks).
 */

export type CardId = 'now' | 'timeline' | 'delivery' | 'usage' | 'health'

export const DASH_DEFAULT: readonly CardId[] = ['now', 'timeline', 'delivery', 'usage', 'health']

/** `{ order: [], hidden: [] }` is the default, so a later default applies in full. */
export interface Layout {
  order: CardId[]
  hidden: CardId[]
}

const isCard = (v: unknown): v is CardId => typeof v === 'string' && (DASH_DEFAULT as readonly string[]).includes(v)

function cleanIds(raw: unknown): CardId[] {
  if (!Array.isArray(raw)) return []
  const out: CardId[] = []
  for (const v of raw) if (isCard(v) && !out.includes(v)) out.push(v)
  return out
}

/**
 * A saved layout as read from storage: known ids only, once each. Anything else is the default.
 * Unknown ids are dropped, not kept: the layout is per device, so a downgrade costs at most a
 * newer card's place.
 */
export function cleanLayout(raw: unknown): Layout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { order: [], hidden: [] }
  const r = raw as { order?: unknown; hidden?: unknown }
  return { order: cleanIds(r.order), hidden: cleanIds(r.hidden) }
}

/**
 * Every card in the order to draw, hidden ones included: the saved order, and every default card
 * it lacks (one added in a later version) after the card before it in the default, else first.
 */
export function layoutOrder(saved: Layout): CardId[] {
  const out = cleanIds(saved.order)
  DASH_DEFAULT.forEach((id, i) => {
    if (out.includes(id)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(DASH_DEFAULT[j])
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, id)
  })
  return out
}

const sameOrder = (order: readonly CardId[]) => {
  const o = layoutOrder({ order: [...order], hidden: [] })
  return o.every((id, i) => id === DASH_DEFAULT[i])
}

export const isDefault = (layout: Layout) => sameOrder(layout.order) && cleanIds(layout.hidden).length === 0

/** What storage keeps: the default order as `[]` (so later defaults apply), and the hidden cards. */
export function toSaved(layout: Layout): Layout {
  return {
    order: sameOrder(layout.order) ? [] : layoutOrder(layout),
    hidden: cleanIds(layout.hidden),
  }
}

/** `layout` with `id` hidden or shown; its place in the order is untouched. */
export function setHidden(layout: Layout, id: CardId, hidden: boolean): Layout {
  const rest = cleanIds(layout.hidden).filter((h) => h !== id)
  return { order: [...layout.order], hidden: hidden ? [...rest, id] : rest }
}

/** `order` with `id` moved to just before index `before` (`order.length`: the end), clamped. */
export function moveTo(order: readonly CardId[], id: CardId, before: number): CardId[] {
  const from = order.indexOf(id)
  if (from < 0) return [...order]
  const out = order.filter((_, i) => i !== from)
  const at = Math.max(0, Math.min(out.length, before > from ? before - 1 : before))
  out.splice(at, 0, id)
  return out
}

/**
 * ⌥ and an arrow: `id` moved one place past the next shown card before or after it. Cards that
 * `shown` says are hidden are passed over and keep their place; at either end nothing moves.
 */
export function moveStep(order: readonly CardId[], id: CardId, dir: -1 | 1, shown: (id: CardId) => boolean = () => true): CardId[] {
  const from = order.indexOf(id)
  if (from < 0) return [...order]
  for (let j = from + dir; j >= 0 && j < order.length; j += dir) {
    if (shown(order[j])) return moveTo(order, id, dir > 0 ? j + 1 : j)
  }
  return [...order]
}

/** The phone's one column: the saved order, hidden cards left out (Needs attention is drawn first, outside it). */
export function phoneOrder(layout: Layout): CardId[] {
  const hidden = cleanIds(layout.hidden)
  return layoutOrder(layout).filter((id) => !hidden.includes(id))
}

/**
 * A drawn card's box in page pixels, as `getBoundingClientRect()` gives it (a DOMRect fits), with
 * the card's id. Pass the shown cards in drawn order, the dragged one left out.
 */
export interface CardRect {
  id: CardId
  left: number
  top: number
  width: number
  height: number
}

/** Where a drop lands: before or after the card `id`, at `index` in the rects given. */
export interface Drop {
  id: CardId
  index: number
  after: boolean
}

const overlapY = (a: CardRect, b: CardRect) => a.top < b.top + b.height && b.top < a.top + a.height

/**
 * The card nearest the pointer, and which side of it the drop goes. Nearest is by distance to the
 * card's box, so a pointer inside a card (a wide one too) is on that card, and ties (in a gap)
 * go to the nearer centre. The side is the pointer's side of that centre on the main axis: across
 * when any two cards share a row, else (one column) down. Null when no card is drawn.
 */
export function dropNearest(rects: readonly CardRect[], x: number, y: number): Drop | null {
  if (!rects.length) return null
  let best = 0
  let bestBox = Infinity
  let bestMid = Infinity
  rects.forEach((r, i) => {
    const dx = Math.max(r.left - x, 0, x - (r.left + r.width))
    const dy = Math.max(r.top - y, 0, y - (r.top + r.height))
    const box = Math.hypot(dx, dy)
    const mid = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2))
    if (box < bestBox || (box === bestBox && mid < bestMid)) {
      best = i
      bestBox = box
      bestMid = mid
    }
  })
  const r = rects[best]
  const across = rects.some((a, i) => rects.some((b, j) => i < j && overlapY(a, b)))
  const after = across ? x >= r.left + r.width / 2 : y >= r.top + r.height / 2
  return { id: r.id, index: best, after }
}

/** A drop as the `before` index `moveTo` takes in `order`; a card not in it means the end. */
export function dropTo(order: readonly CardId[], drop: Drop): number {
  const i = order.indexOf(drop.id)
  return i < 0 ? order.length : i + (drop.after ? 1 : 0)
}
