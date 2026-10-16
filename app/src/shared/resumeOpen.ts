import type { Session } from './types'

/** A resume that succeeded, for the window to open (issue #133). */
export interface ResumeTarget {
  /** The background id `claude --bg --resume` printed (its Session.key); null: it printed none. */
  key: string | null
  /** The conversation that was resumed. */
  sessionId: string
  name: string
  /** When the resume was asked (ms). */
  at: number
}

/**
 * The listed session a resume woke, once it runs: by its key, else its sessionId (a bare resume
 * keeps its ids), else its name for one that started after the resume (a copy under new ids).
 * A stopped row is never it: the list can show the old row for a few seconds, and attaching that
 * would resume it a second time.
 */
export function resumedSession(sessions: Session[], t: ResumeTarget): Session | null {
  const live = sessions.filter(
    (s) => s.kind === 'background' && (s.pid !== null || (s.state !== 'done' && s.state !== 'suspended')),
  )
  return (
    (t.key ? live.find((s) => s.key === t.key || s.bgId === t.key) : undefined) ??
    live.find((s) => s.sessionId === t.sessionId) ??
    live.find((s) => s.name === t.name && s.startedAt >= t.at - 10_000) ??
    null
  )
}
