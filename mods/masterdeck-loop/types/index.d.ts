/**
 * One agent loop in this session: Claude works in rounds until `check` passes or `max` rounds ran.
 * - `running`: Claude works on round `round` (`turnId` once that turn started)
 * - `checking`: the turn ended and the check runs
 * - `passed`, `gave-up` (max rounds, still failing), `stopped` (interrupted, Stop, switched off)
 */
export type Loop = {
  check: string
  goal: string
  max: number
  round: number
  status: 'running' | 'checking' | 'passed' | 'gave-up' | 'stopped'
  turnId: string | null
  /** Why it stopped, in words (stopped only). */
  note: string | null
  /** The last check: its exit code and last lines. */
  last: { exit: number; tail: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    'masterdeck-loop': { loop: Loop | null }
  }
}
