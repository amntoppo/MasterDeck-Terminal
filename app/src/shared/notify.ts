import type { AppState, NotifyEvent } from './types'

/** Desktop notifications for session transitions (finished, ready for review, merged). Silent on the
 * first load. Needs-you items announce themselves through the inbox's events. */
export function diffEvents(prev: AppState | null, next: AppState, focusedSessionId: string | null): NotifyEvent[] {
  if (!prev) return []
  const out: NotifyEvent[] = []
  const before = new Map(prev.sessions.map((s) => [s.key, s]))
  for (const s of next.sessions) {
    const p = before.get(s.key)
    if (!p) continue
    // Needs input, questions, proposals, budgets and context warnings come from the inbox's events.
    if (s.state === 'idle' && p.state === 'working' && s.sessionId !== focusedSessionId) {
      out.push({ title: `${s.name} finished`, body: 'The session went idle.', target: { sessionKey: s.key } })
    }
  }
  // A session's PR moving to Ready for Review or Merged (not one first seen there, e.g. at startup).
  for (const s of next.sessions) {
    const was = prev.prStage[s.key]
    const now = next.prStage[s.key]
    if (!was || !now || was.kind === now.kind) continue
    if (now.kind === 'ready') out.push({ title: `${s.name} is ready for review`, body: `PR ${now.prs.map((n) => `#${n}`).join(', ')}: ${now.why}.`, target: { sessionKey: s.key } })
    if (now.kind === 'merged') out.push({ title: `${s.name}: PR merged`, body: `${now.prs.map((n) => `#${n}`).join(', ')} merged.`, target: { sessionKey: s.key } })
  }
  return out
}

/** Sessions that just started needing input (for auto-open). */
export function newlyNeedsInput(prev: AppState | null, next: AppState): string[] {
  if (!prev) return []
  const before = new Map(prev.sessions.map((s) => [s.key, s.state]))
  return next.sessions.filter((s) => s.state === 'needs-input' && before.has(s.key) && before.get(s.key) !== 'needs-input').map((s) => s.key)
}
