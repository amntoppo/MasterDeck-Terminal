/**
 * A small fuzzy matcher for the command palette: every query character must appear in order.
 * Consecutive runs, word starts and an early first match score higher. Null means no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  const exact = t.indexOf(q)
  if (exact >= 0) return 1000 - exact + (exact === 0 || /[\s#/_.-]/.test(t[exact - 1]) ? 200 : 0)
  let score = 0
  let ti = 0
  let run = 0
  let first = -1
  for (const ch of q) {
    if (ch === ' ') continue
    const at = t.indexOf(ch, ti)
    if (at < 0) return null
    if (first < 0) first = at
    run = at === ti ? run + 1 : 0
    score += 10 + run * 5 + (at === 0 || /[\s#/_.-]/.test(t[at - 1]) ? 15 : 0)
    ti = at + 1
  }
  // Letters scattered across a long title are not a match ("notif" in "Selection … setup").
  if (ti - first > q.replace(/ /g, '').length * 3) return null
  return score - first
}

export interface Ranked<T> {
  item: T
  score: number
}

/** Items whose text matches, best first; ties keep their original order. */
export function rank<T>(query: string, items: T[], text: (t: T) => string, limit = 50): T[] {
  const out: (Ranked<T> & { i: number })[] = []
  items.forEach((item, i) => {
    const score = fuzzyScore(query, text(item))
    if (score !== null) out.push({ item, score, i })
  })
  out.sort((a, b) => b.score - a.score || a.i - b.i)
  return out.slice(0, limit).map((r) => r.item)
}
