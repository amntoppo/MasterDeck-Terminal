import { describe, expect, it } from 'vitest'
import {
  cleanLayout,
  DASH_DEFAULT,
  dropNearest,
  dropTo,
  isDefault,
  layoutOrder,
  moveStep,
  moveTo,
  phoneOrder,
  setHidden,
  toSaved,
  type CardId,
  type CardRect,
  type Layout,
} from './dashboardLayout'

const D = [...DASH_DEFAULT]
const EMPTY: Layout = { order: [], hidden: [] }

describe('cleanLayout', () => {
  it('anything but an object is the default', () => {
    expect(cleanLayout(null)).toEqual(EMPTY)
    expect(cleanLayout('x')).toEqual(EMPTY)
    expect(cleanLayout([1, 2])).toEqual(EMPTY)
  })

  it('non-arrays become empty lists', () => {
    expect(cleanLayout({ order: 'now', hidden: { a: 1 } })).toEqual(EMPTY)
  })

  it('keeps known ids once each, and drops junk', () => {
    const raw = { order: ['usage', 7, 'usage', 'future', null, 'now', ''], hidden: ['health', 'health', 'nope', 3] }
    expect(cleanLayout(raw)).toEqual({ order: ['usage', 'now'], hidden: ['health'] })
  })
})

describe('layoutOrder', () => {
  it('nothing saved is the default', () => {
    expect(layoutOrder(EMPTY)).toEqual(D)
  })

  it('keeps a saved order', () => {
    const order: CardId[] = ['health', 'usage', 'delivery', 'timeline', 'now']
    expect(layoutOrder({ order, hidden: [] })).toEqual(order)
  })

  it('a new card goes in after its predecessor in the default', () => {
    // Saved before Delivery existed, with Health moved first.
    expect(layoutOrder({ order: ['health', 'now', 'timeline', 'usage'], hidden: [] })).toEqual([
      'health',
      'now',
      'timeline',
      'delivery',
      'usage',
    ])
  })

  it('a new first card goes first', () => {
    expect(layoutOrder({ order: ['usage', 'timeline', 'delivery', 'health'], hidden: [] })[0]).toBe('now')
  })

  it('cleans what it is given', () => {
    const raw = { order: ['x', 'usage', 'usage', 'now'], hidden: [] } as unknown as Layout
    expect(layoutOrder(raw)).toEqual(['usage', 'health', 'now', 'timeline', 'delivery'])
  })
})

describe('moveTo', () => {
  it('moves a card forward and back', () => {
    expect(moveTo(D, 'usage', 0)).toEqual(['usage', 'now', 'timeline', 'delivery', 'health'])
    expect(moveTo(D, 'now', 2)).toEqual(['timeline', 'now', 'delivery', 'usage', 'health'])
  })

  it('to the end, and clamped past the ends', () => {
    expect(moveTo(D, 'now', D.length).at(-1)).toBe('now')
    expect(moveTo(D, 'now', 99).at(-1)).toBe('now')
    expect(moveTo(D, 'health', -5)[0]).toBe('health')
  })

  it('in place, or an unknown id, changes nothing', () => {
    expect(moveTo(D, 'delivery', 2)).toEqual(D)
    expect(moveTo(D, 'delivery', 3)).toEqual(D)
    expect(moveTo(D, 'nope' as CardId, 0)).toEqual(D)
  })
})

describe('moveStep', () => {
  it('swaps with the neighbour', () => {
    expect(moveStep(D, 'timeline', 1)).toEqual(['now', 'delivery', 'timeline', 'usage', 'health'])
    expect(moveStep(D, 'timeline', -1)).toEqual(['timeline', 'now', 'delivery', 'usage', 'health'])
  })

  it('stops at the ends', () => {
    expect(moveStep(D, 'now', -1)).toEqual(D)
    expect(moveStep(D, 'health', 1)).toEqual(D)
  })

  it('passes over hidden cards, which keep their place', () => {
    expect(moveStep(D, 'timeline', 1, (id) => id !== 'delivery')).toEqual(['now', 'delivery', 'usage', 'timeline', 'health'])
    // The last shown card does not move past hidden ones at the end.
    expect(moveStep(D, 'usage', 1, (id) => id !== 'health')).toEqual(D)
  })
})

describe('isDefault / toSaved', () => {
  it('the default is saved as empty, so a later default applies in full', () => {
    expect(toSaved({ order: D, hidden: [] })).toEqual(EMPTY)
    expect(isDefault(EMPTY)).toBe(true)
    expect(isDefault({ order: D, hidden: [] })).toBe(true)
  })

  it('a moved order is kept, and is not the default', () => {
    const order = moveTo(D, 'health', 0)
    expect(isDefault({ order, hidden: [] })).toBe(false)
    expect(toSaved({ order, hidden: [] })).toEqual({ order, hidden: [] })
  })

  it('a hidden card is not the default, and the default order is still saved empty', () => {
    const l: Layout = { order: D, hidden: ['usage'] }
    expect(isDefault(l)).toBe(false)
    expect(toSaved(l)).toEqual({ order: [], hidden: ['usage'] })
  })
})

describe('hidden cards', () => {
  it('keep their place in the order', () => {
    const l = setHidden(EMPTY, 'delivery', true)
    expect(l.hidden).toEqual(['delivery'])
    expect(layoutOrder(l)).toEqual(D)
    expect(isDefault(setHidden(l, 'delivery', false))).toBe(true)
  })

  it('a hidden card moved stays hidden, and keeps its new place', () => {
    const l: Layout = { order: moveTo(D, 'delivery', 0), hidden: ['delivery'] }
    expect(layoutOrder(l)[0]).toBe('delivery')
    expect(phoneOrder(l)).toEqual(['now', 'timeline', 'usage', 'health'])
  })

  it('hiding twice is one entry', () => {
    expect(setHidden(setHidden(EMPTY, 'now', true), 'now', true).hidden).toEqual(['now'])
  })
})

describe('phoneOrder', () => {
  it('keeps the saved order without hidden cards', () => {
    const order: CardId[] = ['usage', 'now', 'timeline', 'delivery', 'health']
    expect(phoneOrder({ order, hidden: ['timeline'] })).toEqual(['usage', 'now', 'delivery', 'health'])
    expect(phoneOrder(EMPTY)).toEqual(D)
  })
})

describe('dropNearest', () => {
  // A 3-column grid of 100 x 80 cards with a 20 gap: row one now · timeline (span 2), row two
  // delivery · usage · health.
  const r = (id: CardId, col: number, row: number, span = 1): CardRect => ({
    id,
    left: col * 120,
    top: row * 100,
    width: span * 100 + (span - 1) * 20,
    height: 80,
  })
  const rects = [r('now', 0, 0), r('timeline', 1, 0, 2), r('delivery', 0, 1), r('usage', 1, 1), r('health', 2, 1)]

  it('picks the card under the pointer and the side of its centre', () => {
    expect(dropNearest(rects, 10, 40)).toEqual({ id: 'now', index: 0, after: false })
    expect(dropNearest(rects, 90, 40)).toEqual({ id: 'now', index: 0, after: true })
    expect(dropNearest(rects, 130, 140)).toEqual({ id: 'usage', index: 3, after: false })
    expect(dropNearest(rects, 330, 140)).toEqual({ id: 'health', index: 4, after: true })
  })

  it('in a gap, the nearer card wins', () => {
    expect(dropNearest(rects, 105, 140)?.id).toBe('delivery')
    expect(dropNearest(rects, 115, 140)?.id).toBe('usage')
  })

  it('a wide card owns all of its box', () => {
    // Inside Timeline's right end, which is nearer Health's centre than Timeline's.
    expect(dropNearest(rects, 335, 75)).toEqual({ id: 'timeline', index: 1, after: true })
    expect(dropNearest(rects, 125, 10)).toEqual({ id: 'timeline', index: 1, after: false })
  })

  it('a pointer outside the grid goes to the nearest card', () => {
    expect(dropNearest(rects, -50, -50)).toEqual({ id: 'now', index: 0, after: false })
    expect(dropNearest(rects, 900, 500)).toEqual({ id: 'health', index: 4, after: true })
    expect(dropNearest(rects, 180, 900)).toEqual({ id: 'usage', index: 3, after: true })
  })

  it('one column: the side is above or below', () => {
    const col = [r('now', 0, 0), r('timeline', 0, 1)]
    expect(dropNearest(col, 90, 30)).toEqual({ id: 'now', index: 0, after: false })
    expect(dropNearest(col, 10, 70)).toEqual({ id: 'now', index: 0, after: true })
  })

  it('no cards, no drop', () => {
    expect(dropNearest([], 0, 0)).toBeNull()
  })

  it('dropTo turns a drop into an index for moveTo', () => {
    const d = dropNearest(rects, 330, 140)
    expect(d && moveTo(D, 'now', dropTo(D, d))).toEqual(['timeline', 'delivery', 'usage', 'health', 'now'])
    const b = dropNearest(rects, 130, 140)
    expect(b && moveTo(D, 'health', dropTo(D, b))).toEqual(['now', 'timeline', 'delivery', 'health', 'usage'])
    expect(dropTo(D, { id: 'gone' as CardId, index: 0, after: false })).toBe(D.length)
  })
})
