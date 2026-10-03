import { MASTER_NAME } from './derive'
import { ticketKey, ticketLabel } from './ticket'
import type { LinkInfo, SessionHistory } from './carry'

/**
 * A session that worked on an issue and is not running now, but can be resumed: its transcript is
 * still on disk, and `claude --bg --resume <sessionId>` continues it.
 */
export interface PastSession {
  sessionId: string
  issue: number
  /** The issue's repo (owner/name); null or missing: the primary issue repo. */
  repo?: string | null
  name: string
  cwd: string | null
  lastActivity: number
  /** The GitHub account it was started as (two or more accounts, when recorded). */
  account?: string
}

export interface TranscriptInfo {
  mtime: number
  title: string | null
  cwd: string | null
}

/**
 * Past sessions per ticket (by ticketKey), newest first, from babysit-ticket's links. A background session keeps
 * its background id across resumes but gets new session ids; those count as one session, resumed
 * from its newest id that still has a transcript. A session running now (any of its ids) is left out.
 */
export function pastByIssue(
  links: Map<string, LinkInfo>,
  history: SessionHistory,
  liveIds: Set<string>,
  info: (sessionId: string) => TranscriptInfo | null,
): Record<string, PastSession[]> {
  const groupOf = new Map<string, string>()
  for (const [bg, ids] of Object.entries(history)) for (const id of ids) groupOf.set(id, bg)
  const groups = new Map<string, { issue: number; repo: string | null; at: number; ids: string[] }>()
  for (const [id, l] of links) {
    // A resumed id not in the history yet still starts with its background id.
    const g = groupOf.get(id) ?? Object.keys(history).find((bg) => id.startsWith(bg)) ?? id
    const cur = groups.get(g) ?? { issue: l.issue, repo: l.repo ?? null, at: -1, ids: [] }
    cur.ids.push(id)
    // Relinked to another issue: the latest link counts.
    if ((l.linkedAt ?? 0) >= cur.at) {
      cur.issue = l.issue
      cur.repo = l.repo ?? null
      cur.at = l.linkedAt ?? 0
    }
    groups.set(g, cur)
  }
  const out: Record<string, PastSession[]> = {}
  for (const [g, { issue, repo, ids }] of groups) {
    const all = [...new Set([...ids, ...(history[g] ?? [])])]
    if (all.some((id) => liveIds.has(id))) continue
    let best: (TranscriptInfo & { id: string }) | null = null
    for (const id of all) {
      const t = info(id)
      if (t && (!best || t.mtime > best.mtime)) best = { ...t, id }
    }
    // master-agent is never a ticket's session, even when a link says so.
    if (!best || best.title === MASTER_NAME) continue
    ;(out[ticketKey(repo, issue)] ??= []).push({ sessionId: best.id, issue, repo, name: best.title ?? `${ticketLabel(repo, issue)} ${best.id.slice(0, 8)}`, cwd: best.cwd, lastActivity: best.mtime })
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.lastActivity - a.lastActivity)
  return out
}
