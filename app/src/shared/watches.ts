/**
 * Monitors run by MasterDeck (Settings → Monitors run by: MasterDeck). Claude Code stops every
 * monitor after 30 minutes; with this setting MasterDeck's hook catches a session's Monitor call,
 * MasterDeck runs the same script with no time limit, and each line it prints reaches the session
 * as a message once its turn is over.
 */

export type MonitorsBy = 'claude' | 'masterdeck'

/** A Monitor call the hook handed over (`deck/watch-requests/<id>.json`). */
export interface WatchRequest {
  id: string
  at: number
  sessionId: string
  cwd: string
  command: string
  description: string
}

/** A monitor MasterDeck runs, as the app shows it. */
export interface WatchInfo {
  id: string
  sessionId: string
  description: string
  command: string
  startedAt: number
  events: number
  lastEventAt: number | null
  /** Lines waiting for the session's turn to end. */
  queued: number
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** The hook's file: `{id, at, data}` where data is the PreToolUse input. Null unless it is a command Monitor. */
export function parseWatchRequest(text: string): WatchRequest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const data = (o.data ?? {}) as Record<string, unknown>
  const input = (data.tool_input ?? {}) as Record<string, unknown>
  const id = str(o.id, 80)
  const sessionId = str(data.session_id, 80)
  const command = str(input.command, 100_000)
  if (!/^[0-9A-Za-z-]{1,80}$/.test(id) || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null
  if (data.tool_name !== 'Monitor' || !command.trim()) return null
  return {
    id,
    at: typeof o.at === 'number' ? o.at : Date.now(),
    sessionId,
    cwd: str(data.cwd, 4000),
    command,
    description: str(input.description, 200).trim() || 'monitor',
  }
}

/** Same session, same script: the monitor is already running (a re-arm). */
export const sameWatch = (a: { sessionId: string; command: string }, b: { sessionId: string; command: string }): boolean =>
  a.sessionId === b.sessionId && a.command.trim() === b.command.trim()

/** The hook's answer: the Monitor call is not run by Claude Code; why, and what happens instead. */
export function handedOver(description: string, already: boolean): object {
  const reason = already
    ? `MasterDeck is already running this monitor ("${description}") for this session, with no time limit. Do not arm or re-arm it; its events keep arriving as messages.`
    : `MasterDeck runs this monitor ("${description}") for you, with no time limit: it will not expire, so do not re-arm it. ` +
      `Each line it prints reaches you as a message starting "[MasterDeck monitor: ${description}]"; act on those as you would on Monitor events. ` +
      'It ends when its script exits (that arrives as a last message too). This is not an error: carry on with your task.'
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

/** One message for everything that is waiting for a session: grouped by monitor, oldest first. */
export function eventMessage(groups: { description: string; lines: string[] }[]): string {
  return groups
    .filter((g) => g.lines.length)
    .map((g) => `[MasterDeck monitor: ${g.description}]\n${g.lines.join('\n')}`)
    .join('\n\n')
}

/** Most lines kept per monitor while a session is busy; older ones are dropped (and counted). */
export const QUEUE_MAX = 200

/** Add lines to a queue, keeping the newest `QUEUE_MAX`; says how many were dropped. */
export function enqueue(queue: string[], lines: string[]): number {
  queue.push(...lines)
  const over = queue.length - QUEUE_MAX
  if (over > 0) queue.splice(0, over)
  return Math.max(0, over)
}

/** A session can take a message now: its turn is over and nothing asks it anything. */
export function canDeliver(s: { state: string; waitingOn?: string | null; busyWith?: string | null }): boolean {
  if (s.state === 'idle') return true
  // "Working" only because of background work it started: the turn is over, a message is taken.
  return s.state === 'working' && !!(s.waitingOn || s.busyWith)
}
