/**
 * The Tasks view: each session as a task moving through a fixed set of steps, grouped into lanes
 * by what it needs. The step comes from where its PRs stand (prStage); the lane and colour from
 * its status (sessionStatus).
 */
import type { PrStage, StatusKey } from './review'
import type { Session } from './types'

export const STEPS = ['Started', 'Coding', 'PR open', 'Review', 'Merged'] as const

export type Tone = 'ok' | 'busy' | 'wait' | 'bad' | 'info' | 'done' | 'off'

export interface TaskStep {
  /** Index into STEPS of the step the task is on. */
  at: number
  /** How that step is going. */
  tone: Tone
  /** A few words about that step, e.g. "CI failing". */
  note: string
}

const TONE: Record<StatusKey, Tone> = {
  'needs-input': 'bad',
  question: 'bad',
  blocked: 'bad',
  'ci-failing': 'bad',
  changes: 'wait',
  working: 'busy',
  rework: 'busy',
  'in-review': 'info',
  waiting: 'info',
  ready: 'info',
  approved: 'ok',
  merged: 'done',
  idle: 'wait',
  suspended: 'off',
  done: 'off',
}

export function toneOf(status: StatusKey): Tone {
  return TONE[status] ?? 'off'
}

const PR_KINDS: PrStage['kind'][] = ['merged', 'rework', 'approved', 'changes', 'ci-failing', 'ready', 'in-review']

/**
 * Where a task is: its PR stage decides the step, its status how that step is going. A status set
 * by hand (`manual`) wins over the PR stage, so the step follows it at once.
 */
export function taskStep(status: StatusKey, stage: PrStage | null | undefined, manual = false): TaskStep {
  // A PR status set by hand moves the step; others (Blocked, Working…) keep it and only recolour it.
  if (manual && (PR_KINDS as string[]).includes(status)) stage = { kind: status as PrStage['kind'], prs: stage?.prs ?? [], why: '' }
  const tone = toneOf(status)
  switch (stage?.kind) {
    case 'merged':
      return { at: 4, tone: 'done', note: 'merged' }
    case 'rework':
      return { at: 1, tone: status === 'idle' ? 'wait' : tone, note: 'more work after merge' }
    case 'approved':
      return { at: 3, tone: status === 'working' || HOT.includes(status) ? tone : 'ok', note: 'approved' }
    case 'changes':
      return { at: 3, tone: status === 'working' ? 'busy' : 'wait', note: 'changes requested' }
    case 'ready':
      return { at: 3, tone: status === 'working' || HOT.includes(status) ? tone : 'info', note: 'ready for review' }
    case 'ci-failing':
      return { at: 2, tone: status === 'working' ? 'busy' : 'bad', note: 'CI failing' }
    case 'in-review':
      return { at: 2, tone: status === 'working' || HOT.includes(status) ? tone : 'info', note: 'checks running' }
    default:
      return { at: 1, tone, note: status === 'working' ? 'coding' : status === 'waiting' ? 'waiting on a background task' : status === 'idle' ? 'no PR yet' : '' }
  }
}

/** Statuses that want the user. */
export const HOT: StatusKey[] = ['needs-input', 'question', 'blocked', 'ci-failing', 'changes']

export type Lane = 'you' | 'working' | 'review' | 'idle' | 'done' | 'parked'

export const LANES: { id: Lane; title: string; hint: string }[] = [
  { id: 'you', title: 'Needs you', hint: 'waiting on your answer, blocked, failing CI or changes requested' },
  { id: 'working', title: 'Working', hint: 'running right now, or waiting on a monitor or background task it started' },
  { id: 'review', title: 'In review', hint: 'a PR is open and waiting on checks or reviewers' },
  { id: 'idle', title: 'Idle', hint: 'nothing running, no question: waiting for your next instruction' },
  { id: 'done', title: 'Merged', hint: 'its PRs are merged' },
  { id: 'parked', title: 'Parked', hint: 'suspended; opening one resumes it' },
]

export function laneOf(status: StatusKey): Lane {
  if (HOT.includes(status)) return 'you'
  if (status === 'working' || status === 'rework' || status === 'waiting') return 'working'
  if (status === 'in-review' || status === 'ready' || status === 'approved') return 'review'
  if (status === 'merged') return 'done'
  if (status === 'suspended' || status === 'done') return 'parked'
  return 'idle'
}

export type ActivityKey = 'working' | 'needs-input' | 'question' | 'waiting' | 'idle' | 'parked'

/**
 * What the session itself is doing right now, apart from where its PR stands: working, waiting on
 * a prompt, asking you something, waiting on background work it started, or idle (none of those:
 * waiting for your next instruction).
 */
export function activityOf(s: Pick<Session, 'state' | 'waitingOn' | 'asking'>): { key: ActivityKey; text: string } {
  if (s.state === 'working' && !s.waitingOn) return { key: 'working', text: 'Working' }
  if (s.state === 'needs-input') return { key: 'needs-input', text: 'Needs Input' }
  if (s.state === 'suspended' || s.state === 'done') return { key: 'parked', text: s.state === 'done' ? 'Ended' : 'Parked' }
  if (s.asking) return { key: 'question', text: 'Asked you' }
  if (s.waitingOn) return { key: 'waiting', text: 'Waiting' }
  return { key: 'idle', text: 'Idle' }
}
