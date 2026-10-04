import type { Session } from './types'

/**
 * Background sessions don't outlive the machine: a restart (or a crash) ends every session process,
 * though each conversation stays on disk and `claude --bg --resume <id>` (no other flag: any flag
 * starts a copy) continues it under the same id. MasterDeck keeps a list of the background sessions that are running; when it next starts on a
 * new boot, the ones that were running and no longer are can be resumed.
 */

export interface RestoreEntry {
  sessionId: string
  bgId: string | null
  name: string
  cwd: string
  issue: number | null
  /** The issue's repo (owner/name); null or missing: the primary issue repo. */
  issueRepo?: string | null
}

export interface RestoreFile {
  /** When the machine booted (ms), as of the last save. */
  bootAt: number
  savedAt: number
  /** Background sessions with a live process at the last save. */
  running: RestoreEntry[]
  /** Stopped by a restart and not resumed or dismissed yet. */
  stopped: RestoreEntry[]
}

/** Boot times read at different moments differ by rounding; a new boot is minutes apart at least. */
export function sameBoot(a: number, b: number): boolean {
  return Math.abs(a - b) < 120_000
}

/**
 * Background sessions running right now: they have a process. After a restart a killed session can
 * still say `blocked`, so the state alone is not enough. The master session is left out: it has its
 * own Start.
 */
export function runningNow(sessions: Session[], masterName: string): RestoreEntry[] {
  return sessions
    .filter((s) => s.kind === 'background' && s.pid !== null && s.state !== 'done' && s.name !== masterName)
    .map((s) => ({ sessionId: s.sessionId, bgId: s.bgId, name: s.name, cwd: s.cwd, issue: s.issue, ...(s.issueRepo ? { issueRepo: s.issueRepo } : {}) }))
}

/** Runs now: a process under the same session id or the same background id (which survives a resume). */
export function isLive(e: RestoreEntry, sessions: Session[]): boolean {
  return sessions.some((s) => s.pid !== null && s.state !== 'done' && (s.sessionId === e.sessionId || (!!e.bgId && s.bgId === e.bgId)))
}

/**
 * The next file, given the saved one and the sessions now. On a new boot, what was running becomes
 * stopped. Anything live again (resumed here or elsewhere) leaves the stopped list.
 */
export function nextRestore(saved: RestoreFile | null, bootAt: number, sessions: Session[], masterName: string, now: number): RestoreFile {
  const stopped = [...(saved?.stopped ?? [])]
  if (saved && !sameBoot(saved.bootAt, bootAt)) {
    for (const e of saved.running) if (!stopped.some((x) => x.sessionId === e.sessionId)) stopped.push(e)
  }
  return {
    bootAt,
    savedAt: now,
    running: runningNow(sessions, masterName),
    stopped: stopped.filter((e) => !isLive(e, sessions)),
  }
}

/**
 * Resume the stopped sessions one at a time. One that runs again meanwhile (master's ORPHAN, by
 * hand, an earlier pass) is skipped: `sessions()` is read before each. The failed ones stay listed.
 */
export async function resumeEntries(
  stopped: RestoreEntry[],
  sessions: () => Session[],
  resume: (e: RestoreEntry) => Promise<{ ok: boolean; message: string }>,
): Promise<{ resumed: number; failed: string[]; left: RestoreEntry[] }> {
  const failed: string[] = []
  const left: RestoreEntry[] = []
  let resumed = 0
  for (const e of stopped) {
    const r = isLive(e, sessions()) ? { ok: true, message: 'already running' } : await resume(e)
    if (r.ok) resumed++
    else {
      failed.push(`${e.name}: ${r.message}`)
      left.push(e)
    }
  }
  return { resumed, failed, left }
}

export function parseRestoreFile(raw: unknown): RestoreFile | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const list = (v: unknown): RestoreEntry[] =>
    Array.isArray(v)
      ? v
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).sessionId === 'string')
          .map((e) => ({
            sessionId: e.sessionId as string,
            bgId: typeof e.bgId === 'string' ? e.bgId : null,
            name: typeof e.name === 'string' ? e.name : (e.sessionId as string).slice(0, 8),
            cwd: typeof e.cwd === 'string' ? e.cwd : '',
            issue: typeof e.issue === 'number' ? e.issue : null,
            ...(typeof e.issueRepo === 'string' ? { issueRepo: e.issueRepo } : {}),
          }))
      : []
  if (typeof r.bootAt !== 'number') return null
  return { bootAt: r.bootAt, savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0, running: list(r.running), stopped: list(r.stopped) }
}
