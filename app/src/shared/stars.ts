/**
 * Starred sessions: the ones the user pins to a Starred section at the top of the sidebar. A starred
 * session shows only there, whatever its status, until it is unstarred or ends.
 */

interface Starrable {
  key: string
  state: string
}

/** Add `key` to the stars, or take it out. */
export function toggleStar(stars: string[], key: string): string[] {
  return stars.includes(key) ? stars.filter((k) => k !== key) : [...stars, key]
}

/** Split sessions (already in the user's order) into the starred ones and the rest. */
export function splitStarred<T extends Starrable>(sessions: T[], stars: string[]): { starred: T[]; rest: T[] } {
  const set = new Set(stars)
  const starred: T[] = []
  const rest: T[] = []
  for (const s of sessions) (set.has(s.key) && isLive(s) ? starred : rest).push(s)
  return { starred, rest }
}

/**
 * Drop the stars of sessions that ended: done or parked, or gone from the list. Returns `stars` itself
 * when nothing changed. An empty list (state not loaded yet) never clears anything.
 */
export function pruneStars(stars: string[], sessions: Starrable[]): string[] {
  if (!stars.length || !sessions.length) return stars
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  const kept = stars.filter((k) => {
    const s = byKey.get(k)
    return !!s && isLive(s)
  })
  return kept.length === stars.length ? stars : kept
}

function isLive(s: Starrable): boolean {
  return s.state !== 'done' && s.state !== 'suspended'
}
