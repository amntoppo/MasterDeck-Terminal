import type { LinkInfo, SessionHistory } from './carry'

/**
 * A session that worked on an issue and is not running now, but can be resumed: its transcript is
 * still on disk, and `claude --bg --resume <sessionId>` continues it.
 */
export interface PastSession {
  sessionId: string
  issue: number
  name: string
  cwd: string | null
  lastActivity: number
}

export interface TranscriptInfo {
  mtime: number
  title: string | null
  cwd: string | null
}

/**
 * Past sessions per issue, newest first, from babysit-ticket's links. A background session keeps
 * its background id across resumes but gets new session ids; those count as one session, resumed
 * from its newest id that still has a transcript. A session running now (any of its ids) is left out.
 */
export function pastByIssue(
  links: Map<string, LinkInfo>,
  history: SessionHistory,
  liveIds: Set<string>,
  info: (sessionId: string) => TranscriptInfo | null,
): Record<number, PastSession[]> {
  const groupOf = new Map<string, string>()
  for (const [bg, ids] of Object.entries(history)) for (const id of ids) groupOf.set(id, bg)
  const groups = new Map<string, { issue: number; at: number; ids: string[] }>()
  for (const [id, l] of links) {
    // A resumed id not in the history yet still starts with its background id.
    const g = groupOf.get(id) ?? Object.keys(history).find((bg) => id.startsWith(bg)) ?? id
    const cur = groups.get(g) ?? { issue: l.issue, at: -1, ids: [] }
    cur.ids.push(id)
    // Relinked to another issue: the latest link counts.
    if ((l.linkedAt ?? 0) >= cur.at) {
      cur.issue = l.issue
      cur.at = l.linkedAt ?? 0
    }
    groups.set(g, cur)
  }
  const out: Record<number, PastSession[]> = {}
  for (const [g, { issue, ids }] of groups) {
    const all = [...new Set([...ids, ...(history[g] ?? [])])]
    if (all.some((id) => liveIds.has(id))) continue
    let best: (TranscriptInfo & { id: string }) | null = null
    for (const id of all) {
      const t = info(id)
      if (t && (!best || t.mtime > best.mtime)) best = { ...t, id }
    }
    if (!best) continue
    ;(out[issue] ??= []).push({ sessionId: best.id, issue, name: best.title ?? `#${issue} ${best.id.slice(0, 8)}`, cwd: best.cwd, lastActivity: best.mtime })
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.lastActivity - a.lastActivity)
  return out
}
