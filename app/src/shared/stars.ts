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

/** How long a starred session may be missing from the list before its star goes (a poll can miss it). */
export const MISSING_GRACE_MS = 60_000

/**
 * Drop the stars of sessions that ended: done or parked at once, and gone from the list once they
 * have been missing for `graceMs` (a single poll can miss a session). `missingSince` remembers when
 * each starred key was first seen missing; it is updated in place. Returns `stars` itself when
 * nothing changed. An empty list (state not loaded yet) never clears anything.
 */
export function pruneStars(
  stars: string[],
  sessions: Starrable[],
  missingSince: Map<string, number> = new Map(),
  now = Date.now(),
  graceMs = MISSING_GRACE_MS,
): string[] {
  if (!stars.length || !sessions.length) return stars
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  const kept = stars.filter((k) => {
    const s = byKey.get(k)
    if (s) {
      missingSince.delete(k)
      return isLive(s)
    }
    const since = missingSince.get(k) ?? now
    missingSince.set(k, since)
    return now - since < graceMs
  })
  for (const k of [...missingSince.keys()]) if (!kept.includes(k)) missingSince.delete(k)
  return kept.length === stars.length ? stars : kept
}

function isLive(s: Starrable): boolean {
  return s.state !== 'done' && s.state !== 'suspended'
}
