import type { Session, SessionState } from './types'

const WORKING = new Set(['running', 'busy', 'working', 'active'])
const NEEDS_INPUT = new Set(['blocked', 'waiting', 'needs-input', 'needs_input'])
const DONE = new Set(['completed', 'complete', 'done', 'stopped', 'exited', 'dead', 'failed', 'error'])

export function mapState(raw: string): SessionState {
  const s = raw.toLowerCase()
  if (WORKING.has(s)) return 'working'
  if (NEEDS_INPUT.has(s)) return 'needs-input'
  if (DONE.has(s)) return 'done'
  return 'idle'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Normalize `claude agents --json`. Tolerates missing fields; drops rows without a sessionId. */
export function normalizeAgents(raw: unknown): Session[] {
  if (!Array.isArray(raw)) return []
  const out: Session[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const sessionId = str(r.sessionId)
    if (!sessionId) continue
    const kind = r.kind === 'background' ? 'background' : 'interactive'
    // A background row with a live process carries `pid` + `status` (the truth right now) next to
    // a `state` left over from when it was parked. Without a process, `state` is all there is.
    const liveStatus = num(r.pid) !== null ? str(r.status) : null
    const rawState = str(kind === 'background' ? (liveStatus ?? r.state ?? r.status) : (r.status ?? r.state)) ?? 'unknown'
    const bgId = kind === 'background' ? str(r.id) : null
    out.push({
      key: bgId ?? sessionId,
      sessionId,
      name: str(r.name) ?? sessionId.slice(0, 8),
      kind,
      bgId,
      pid: num(r.pid),
      cwd: str(r.cwd) ?? '',
      state: mapState(rawState),
      rawState,
      startedAt: num(r.startedAt) ?? 0,
      issue: null,
    })
  }
  return out
}

/** How long a blocked background session's transcript may stay quiet before it counts as suspended. */
export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * A background session that reports `blocked` but whose transcript has not been written for a
 * day is parked, not waiting on the user (MasterBar's Freshness rule). No transcript → suspended.
 */
export function applyFreshness(sessions: Session[], lastWrite: Record<string, number>, now: number): Session[] {
  return sessions.map((s) => {
    if (s.kind !== 'background' || s.state !== 'needs-input' || s.pid !== null) return s
    const t = lastWrite[s.sessionId]
    const fresh = t !== undefined && now - t < FRESH_WINDOW_MS
    return fresh ? s : { ...s, state: 'suspended' }
  })
}
