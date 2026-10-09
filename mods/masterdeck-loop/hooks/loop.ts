import type { Loop } from '../types'

export const MAX_DEFAULT = 5
export const MAX_CAP = 20

export const USAGE =
  'Usage: /md-loop [--max N] <check command> -- <goal>. Claude works on the goal, then the check runs; while it fails, Claude gets its output and another round, up to N (default 5). /md-loop stop ends it.'

export type LoopArgs =
  | { kind: 'start'; check: string; goal: string; max: number }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'error'; message: string }

/** `/md-loop [--max N] <check> -- <goal>`, `/md-loop stop`, or `/md-loop` alone (where it stands). */
export function parseLoopArgs(args: string): LoopArgs {
  let rest = args.trim()
  if (!rest) return { kind: 'status' }
  if (rest === 'stop') return { kind: 'stop' }
  let max = MAX_DEFAULT
  const m = /^--max\s+(\d+)\s+/.exec(rest)
  if (m) {
    max = Number(m[1])
    rest = rest.slice(m[0].length)
    if (!(max >= 1 && max <= MAX_CAP)) return { kind: 'error', message: `--max takes 1 to ${MAX_CAP} rounds.` }
  }
  const at = rest.indexOf(' -- ')
  if (at < 0) return { kind: 'error', message: USAGE }
  const check = rest.slice(0, at).trim()
  const goal = rest.slice(at + 4).trim()
  if (!check || !goal) return { kind: 'error', message: USAGE }
  return { kind: 'start', check, goal, max }
}

export function newLoop(check: string, goal: string, max: number): Loop {
  return { check, goal, max, round: 1, status: 'running', turnId: null, note: null, last: null }
}

/** The first round's prompt: the goal, and how it ends. */
export function firstPrompt(l: Loop): string {
  return `${l.goal}\n\n(MasterDeck loop, round 1 of ${l.max}: when you finish, \`${l.check}\` runs; the loop ends once it passes.)`
}

/** The next round's prompt: what still fails, and the goal again. */
export function nextPrompt(l: Loop): string {
  const last = l.last ?? { exit: 1, tail: '' }
  return [
    `The check \`${l.check}\` still fails (exit ${last.exit}; round ${l.round} of ${l.max}). Its last lines:`,
    '',
    '```',
    last.tail || '(no output)',
    '```',
    '',
    `Keep working on: ${l.goal}`,
  ].join('\n')
}

/** The last lines of a check's output, for the next round and the progress line. */
export function tailOf(stdout: string, stderr: string, lines = 40, chars = 4000): string {
  const all = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trimEnd().split('\n')
  const tail = all.slice(-lines).join('\n')
  return tail.length > chars ? `…${tail.slice(-chars)}` : tail
}

/** The loop's line above the prompt. */
export function progressText(l: Loop): string {
  const round = `round ${l.round} of ${l.max}`
  switch (l.status) {
    case 'running':
      return `Loop ${round} · Claude is working · check \`${l.check}\``
    case 'checking':
      return `Loop ${round} · running \`${l.check}\`…`
    case 'passed':
      return `✓ Loop done in ${l.round} round${l.round === 1 ? '' : 's'}: \`${l.check}\` passes`
    case 'gave-up':
      return `✗ Loop stopped after ${l.max} rounds: \`${l.check}\` still fails (exit ${l.last?.exit ?? '?'})`
    case 'stopped':
      return `Loop stopped in ${round}${l.note ? `: ${l.note}` : ''}`
  }
}

/** A loop that is still going (a round or a check under way). */
export function isActive(l: Loop | null): boolean {
  return l?.status === 'running' || l?.status === 'checking'
}
