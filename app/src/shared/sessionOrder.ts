/**
 * The sidebar's session order: set by the user (drag, Move to top/bottom), never by activity. A
 * session not seen before goes on top once (newest first); after that it keeps its place.
 */

/** The saved order with sessions it hasn't seen added on top, and gone ones kept (they may resume). */
export function withNew(order: string[], sessions: { key: string; startedAt: number }[]): string[] {
  const known = new Set(order)
  const fresh = sessions.filter((s) => !known.has(s.key)).sort((a, b) => b.startedAt - a.startedAt).map((s) => s.key)
  return fresh.length ? [...fresh, ...order] : order
}

/** Sessions in the saved order (unknown ones first, newest first). */
export function inOrder<T extends { key: string; startedAt: number }>(sessions: T[], order: string[]): T[] {
  const pos = new Map(withNew(order, sessions).map((k, i) => [k, i]))
  return [...sessions].sort((a, b) => (pos.get(a.key) ?? 0) - (pos.get(b.key) ?? 0))
}

/** Move `key` to just before `before` (null: to the end). */
export function moveBefore(order: string[], key: string, before: string | null): string[] {
  if (key === before) return order
  const rest = order.filter((k) => k !== key)
  const i = before === null ? -1 : rest.indexOf(before)
  return i < 0 ? [...rest, key] : [...rest.slice(0, i), key, ...rest.slice(i)]
}

/** Keep the saved list from growing forever: drop the oldest keys past `max`. */
export function trimOrder(order: string[], live: Set<string>, max = 300): string[] {
  if (order.length <= max) return order
  const keep = order.filter((k) => live.has(k))
  return [...keep, ...order.filter((k) => !live.has(k)).slice(0, Math.max(0, max - keep.length))]
}
