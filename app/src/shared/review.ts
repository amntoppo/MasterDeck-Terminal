import { proposalTicket, sessionTicket } from './derive'
import { sameTicket } from './ticket'
import type { PrLive, Proposal, Session } from './types'

/**
 * Session statuses beyond Claude Code's own (working, idle, needs input): where its PR stands, and
 * what master knows (a question, a blocker). They replace "idle"; working and needs input win.
 */

/** Where a session's PRs stand, first match wins. */
export interface PrStage {
  kind: 'merged' | 'rework' | 'approved' | 'changes' | 'ci-failing' | 'ready' | 'in-review'
  /** The PRs it is about (numbers). */
  prs: number[]
  /** Why, in a few words, for tooltips. */
  why: string
}

/**
 * - merged: its PRs are merged, none still open;
 * - rework: merged, but the user gave it more instructions after the last merge
 *   (`instructedAt`); a new PR then goes through the stages below, and once that is merged too
 *   (after the instructions) it is merged again. Any number of PRs, merged at any time;
 * - approved / changes: the review decision of an open PR;
 * - ci-failing: a build or test check failed (not the review check);
 * - ready (Ready for Review): the automated review is done, passed or failed, or nothing new has
 *   been said on the PR for `quietMinutes` (a stale review counts as done);
 * - in-review: the review check runs, or comments came in the last `quietMinutes`.
 * Drafts count: sessions open their PRs as drafts.
 */
export function prStage(urls: string[], live: Record<string, PrLive>, now: number, quietMinutes: number, instructedAt: number | null = null): PrStage | null {
  const prs = urls.map((u) => live[u]).filter((p): p is PrLive => !!p)
  const open = prs.filter((p) => p.state === 'OPEN')
  const nums = (list: PrLive[]) => list.map((p) => p.number)
  if (!open.length) {
    const merged = prs.filter((p) => p.state === 'MERGED')
    if (!merged.length) return null
    const lastMerge = Math.max(...merged.map((p) => p.mergedAt ?? 0))
    if (instructedAt !== null && lastMerge > 0 && instructedAt > lastMerge)
      return { kind: 'rework', prs: nums(merged), why: 'new instructions after its PR was merged; no new PR yet' }
    return { kind: 'merged', prs: nums(merged), why: 'merged' }
  }
  const approved = open.filter((p) => p.reviewDecision === 'APPROVED')
  if (approved.length === open.length) return { kind: 'approved', prs: nums(approved), why: 'approved' }
  const changes = open.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED')
  if (changes.length) return { kind: 'changes', prs: nums(changes), why: 'a reviewer asked for changes' }
  const failing = open.filter((p) => p.buildCi === 'failure')
  if (failing.length) return { kind: 'ci-failing', prs: nums(failing), why: 'a build or test check failed' }

  const times = open.flatMap((p) => [p.createdAt, p.lastCommentAt]).filter((t): t is number => typeof t === 'number')
  const quiet = times.length > 0 && now - Math.max(...times) >= quietMinutes * 60_000
  const reviewed = open.filter((p) => p.reviewCheck === 'success' || p.reviewCheck === 'failure')
  if (reviewed.length === open.length) {
    const failed = reviewed.some((p) => p.reviewCheck === 'failure')
    return { kind: 'ready', prs: nums(open), why: failed ? 'the automated review failed' : 'the automated review passed' }
  }
  if (quiet) return { kind: 'ready', prs: nums(open), why: `no new comments for ${quietMinutes} minutes` }
  const running = open.some((p) => p.reviewCheck === 'pending')
  return { kind: 'in-review', prs: nums(open), why: running ? 'the automated review is running' : 'comments came in lately' }
}

export type StatusKey =
  | 'needs-input'
  | 'working'
  | 'question'
  | 'blocked'
  | 'merged'
  | 'rework'
  | 'approved'
  | 'changes'
  | 'ci-failing'
  | 'ready'
  | 'in-review'
  | 'waiting'
  | 'idle'
  | 'suspended'
  | 'done'

/** Statuses a person can set by hand (not the ones only the session itself can be in). */
export const MANUAL_STATUSES: StatusKey[] = ['working', 'in-review', 'ready', 'changes', 'approved', 'ci-failing', 'merged', 'rework', 'question', 'blocked', 'idle']

export function isStatusKey(v: unknown): v is StatusKey {
  return typeof v === 'string' && v in STATUS_TEXT
}

export const STATUS_TEXT: Record<StatusKey, string> = {
  'needs-input': 'Needs Input',
  working: 'Working',
  question: 'Question',
  blocked: 'Blocked',
  merged: 'Merged',
  rework: 'Rework',
  approved: 'Approved',
  changes: 'Changes Requested',
  'ci-failing': 'CI Failing',
  ready: 'Ready for Review',
  'in-review': 'In Review',
  waiting: 'Waiting',
  idle: 'Idle',
  suspended: 'Suspended',
  done: 'Ended',
}

/** The latest question or blocker master holds for this session (by its name, or its issue). */
export function attentionFor(s: Session, proposals: Proposal[]): Proposal | null {
  const mine = proposals
    .filter((p) => p.kind !== 'CHAT' && (p.status === 'question' || p.status === 'blocked'))
    .filter((p) => p.target.session === s.name || p.target.spawn?.name === s.name || sameTicket(sessionTicket(s), proposalTicket(p)))
  return mine.sort((a, b) => b.id - a.id)[0] ?? null
}

/**
 * A session's status, first match wins: needs input, working, question, blocked, then where its PR
 * stands, then idle. Suspended and ended sessions keep those.
 */
export function sessionStatus(
  s: Pick<Session, 'state' | 'waitingOn' | 'asking' | 'busyWith'>,
  stage: PrStage | null | undefined,
  attention: Proposal | null,
  manual?: StatusKey | null,
): { key: StatusKey; text: string; why: string; manual?: boolean } {
  const out = (key: StatusKey, why = '') => ({ key, text: STATUS_TEXT[key], why })
  if (s.state === 'needs-input') return out('needs-input', 'waiting on a prompt or permission')
  // Set by hand (the status popup): it wins until set back to automatic; a prompt waiting still shows.
  if (manual && manual in STATUS_TEXT && s.state !== 'done') return { ...out(manual, 'set by you'), manual: true }
  // Busy only because of background work it started (turn over, a Monitor live): see waitingOn below.
  if (s.state === 'working' && !s.waitingOn && !s.busyWith) return out('working')
  if (s.state === 'suspended' || s.state === 'done') return out(s.state)
  if (attention?.status === 'question') return out('question', attention.note?.trim() || 'it asked master a question')
  if (attention?.status === 'blocked') return out('blocked', attention.note?.trim() || 'it reported a blocker')
  // Idle (or busy only on background work), from here on. Asking the user something in its last message: a question for you.
  if (s.asking) return out('question', oneLine(s.asking))
  // Its background agents or commands still run: still working.
  if (s.busyWith) return out('working', s.busyWith)
  if (stage) return out(stage.kind, `PR ${stage.prs.map((n) => `#${n}`).join(', ')}: ${stage.why}`)
  // Waiting on a Monitor, a background command or agent, or a wakeup: not on you.
  if (s.waitingOn) return out('waiting', s.waitingOn)
  return out('idle', 'waiting for your next instruction')
}

/** The end of a message, on one line: its question, usually. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `…${flat.slice(-199)}` : flat
}
