/**
 * A resume with another account (or name) starts a copy and leaves the old session listed, stopped
 * (MasterDeck never removes a session). The old one's ids go to `superseded-sessions.json`; while
 * it does not run it is left out of the session list, so one conversation shows once. Running
 * again (resumed by hand), it shows.
 */
export function hideSuperseded<T extends { sessionId: string; bgId: string | null; pid: number | null }>(sessions: T[], ids: Set<string>): T[] {
  if (!ids.size) return sessions
  return sessions.filter((s) => s.pid !== null || !(ids.has(s.sessionId) || (!!s.bgId && ids.has(s.bgId))))
}
