/**
 * Geometry for the Canvas view: session cards on a plane the user pans and zooms. A card's world
 * position is in canvas pixels at zoom 1; the view maps it to the screen as `world * z + (x, y)`.
 */

export interface Pos {
  x: number
  y: number
}

export interface CanvasView {
  x: number
  y: number
  z: number
}

export const CARD_W = 520
export const CARD_H = 360
export const GAP = 36
export const ZOOM_MIN = 0.15
export const ZOOM_MAX = 2.5

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/** Zoom by `factor`, keeping the world point under the screen point (px, py) where it is. */
export function zoomAt(v: CanvasView, factor: number, px: number, py: number): CanvasView {
  const z = clampZoom(v.z * factor)
  const k = z / v.z
  return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
}

/** The world point under a screen point. */
export function toWorld(v: CanvasView, sx: number, sy: number): Pos {
  return { x: (sx - v.x) / v.z, y: (sy - v.y) / v.z }
}

/** The view that shows every card in a `w` × `h` viewport, capped at zoom 1. */
export function fitView(cards: Pos[], w: number, h: number, pad = 48): CanvasView {
  if (!cards.length || w <= 0 || h <= 0) return { x: pad, y: pad, z: 1 }
  const minX = Math.min(...cards.map((c) => c.x))
  const minY = Math.min(...cards.map((c) => c.y))
  const maxX = Math.max(...cards.map((c) => c.x + CARD_W))
  const maxY = Math.max(...cards.map((c) => c.y + CARD_H))
  const z = clampZoom(Math.min(1, (w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxY - minY)))
  return { z, x: (w - (maxX - minX) * z) / 2 - minX * z, y: (h - (maxY - minY) * z) / 2 - minY * z }
}

const cols = (n: number): number => Math.max(3, Math.ceil(Math.sqrt(n)))
const slot = (i: number, c: number): Pos => ({ x: (i % c) * (CARD_W + GAP), y: Math.floor(i / c) * (CARD_H + GAP) })

/** Every card in a tidy grid, in the given order. */
export function arrange(keys: string[]): Record<string, Pos> {
  const c = cols(keys.length)
  return Object.fromEntries(keys.map((k, i) => [k, slot(i, c)]))
}

/**
 * Positions for all `keys`: kept where already placed, and new cards put in the first grid slots
 * no placed card overlaps.
 */
export function placeNew(placed: Record<string, Pos>, keys: string[]): Record<string, Pos> {
  const out: Record<string, Pos> = {}
  const taken: Pos[] = []
  for (const k of keys) {
    const p = placed[k]
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      out[k] = { x: p.x, y: p.y }
      taken.push(out[k])
    }
  }
  const c = cols(keys.length)
  const overlaps = (s: Pos) => taken.some((t) => Math.abs(t.x - s.x) < CARD_W + GAP / 2 && Math.abs(t.y - s.y) < CARD_H + GAP / 2)
  let i = 0
  for (const k of keys) {
    if (out[k]) continue
    while (overlaps(slot(i, c))) i++
    out[k] = slot(i, c)
    taken.push(out[k])
  }
  return out
}

/** Bounds of all cards, in world pixels. */
export function bounds(cards: Pos[]): { x: number; y: number; w: number; h: number } {
  if (!cards.length) return { x: 0, y: 0, w: CARD_W, h: CARD_H }
  const x = Math.min(...cards.map((c) => c.x))
  const y = Math.min(...cards.map((c) => c.y))
  return { x, y, w: Math.max(...cards.map((c) => c.x + CARD_W)) - x, h: Math.max(...cards.map((c) => c.y + CARD_H)) - y }
}
