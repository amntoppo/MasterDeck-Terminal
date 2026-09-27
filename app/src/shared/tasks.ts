/**
 * The Tasks view: each session as a task moving through a fixed set of steps, grouped into lanes
 * by what it needs. The step comes from where its PRs stand (prStage); the lane and colour from
 * its status (sessionStatus).
 */
import type { PrStage, StatusKey } from './review'

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

/** Where a task is: its PR stage decides the step, its status how that step is going. */
export function taskStep(status: StatusKey, stage: PrStage | null | undefined): TaskStep {
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
      return { at: 1, tone, note: status === 'working' ? 'coding' : status === 'idle' ? 'no PR yet' : '' }
  }
}

/** Statuses that want the user. */
export const HOT: StatusKey[] = ['needs-input', 'question', 'blocked', 'ci-failing', 'changes']

export type Lane = 'you' | 'working' | 'review' | 'idle' | 'done' | 'parked'

export const LANES: { id: Lane; title: string; hint: string }[] = [
  { id: 'you', title: 'Needs you', hint: 'waiting on your answer, blocked, failing CI or changes requested' },
  { id: 'working', title: 'Working', hint: 'running right now' },
  { id: 'review', title: 'In review', hint: 'a PR is open and waiting on checks or reviewers' },
  { id: 'idle', title: 'Idle', hint: 'stopped without a PR; probably waiting for instructions' },
  { id: 'done', title: 'Merged', hint: 'its PRs are merged' },
  { id: 'parked', title: 'Parked', hint: 'suspended; opening one resumes it' },
]

export function laneOf(status: StatusKey): Lane {
  if (HOT.includes(status)) return 'you'
  if (status === 'working' || status === 'rework') return 'working'
  if (status === 'in-review' || status === 'ready' || status === 'approved') return 'review'
  if (status === 'merged') return 'done'
  if (status === 'suspended' || status === 'done') return 'parked'
  return 'idle'
}
