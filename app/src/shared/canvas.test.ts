import { describe, expect, it } from 'vitest'
import { arrange, bounds, CARD_H, CARD_W, fitView, GAP, placeNew, toWorld, zoomAt, ZOOM_MAX } from './canvas'

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const v = { x: 40, y: -20, z: 1 }
    const before = toWorld(v, 300, 200)
    const after = zoomAt(v, 2, 300, 200)
    expect(after.z).toBe(2)
    expect(toWorld(after, 300, 200)).toEqual(before)
  })
  it('clamps the zoom', () => {
    expect(zoomAt({ x: 0, y: 0, z: 2 }, 10, 0, 0).z).toBe(ZOOM_MAX)
  })
})

describe('fitView', () => {
  it('shows all cards and never zooms past 1', () => {
    const v = fitView([{ x: 0, y: 0 }], 2000, 2000)
    expect(v.z).toBe(1)
    const many = fitView([{ x: 0, y: 0 }, { x: 3000, y: 2000 }], 1000, 800)
    expect(many.z).toBeLessThan(1)
    // both corners land inside the viewport
    expect(many.x).toBeGreaterThanOrEqual(0)
    expect(many.x + (3000 + CARD_W) * many.z).toBeLessThanOrEqual(1000)
  })
})

describe('placeNew', () => {
  it('keeps placed cards and puts new ones in free slots', () => {
    const out = placeNew({ a: { x: 0, y: 0 } }, ['a', 'b', 'c'])
    expect(out.a).toEqual({ x: 0, y: 0 })
    expect(out.b).toEqual({ x: CARD_W + GAP, y: 0 })
    expect(out.c).toEqual({ x: 2 * (CARD_W + GAP), y: 0 })
  })
  it('skips a slot a moved card covers', () => {
    const out = placeNew({ a: { x: CARD_W + GAP + 10, y: 5 } }, ['a', 'b'])
    expect(out.b).toEqual({ x: 0, y: 0 })
    const out2 = placeNew({ a: { x: 10, y: 5 } }, ['a', 'b'])
    expect(out2.b).toEqual({ x: CARD_W + GAP, y: 0 })
  })
})

describe('arrange and bounds', () => {
  it('lays cards in rows of at least 3', () => {
    const out = arrange(['a', 'b', 'c', 'd'])
    expect(out.d).toEqual({ x: 0, y: CARD_H + GAP })
    expect(bounds(Object.values(out))).toEqual({ x: 0, y: 0, w: 3 * CARD_W + 2 * GAP, h: 2 * CARD_H + GAP })
  })
})
