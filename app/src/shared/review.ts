import type { PrLive, Proposal, Session } from './types'

/**
 * Session statuses beyond Claude Code's own (working, idle, needs input): where its PR stands, and
 * what master knows (a question, a blocker). They replace "idle"; working and needs input win.
 */

/** Where a session's PRs stand, first match wins. */
export interface PrStage {
  kind: 'merged' | 'approved' | 'changes' | 'ci-failing' | 'ready' | 'in-review'
  /** The PRs it is about (numbers). */
  prs: number[]
  /** Why, in a few words, for tooltips. */
  why: string
}

/**
 * - merged: its PRs are merged, none still open;
 * - approved / changes: the review decision of an open PR;
 * - ci-failing: a build or test check failed (not the review check);
 * - ready (Ready for Review): the automated review is done, passed or failed, or nothing new has
 *   been said on the PR for `quietMinutes` (a stale review counts as done);
 * - in-review: the review check runs, or comments came in the last `quietMinutes`.
 * Drafts count: sessions open their PRs as drafts.
 */
export function prStage(urls: string[], live: Record<string, PrLive>, now: number, quietMinutes: number): PrStage | null {
  const prs = urls.map((u) => live[u]).filter((p): p is PrLive => !!p)
  const open = prs.filter((p) => p.state === 'OPEN')
  const nums = (list: PrLive[]) => list.map((p) => p.number)
  if (!open.length) {
    const merged = prs.filter((p) => p.state === 'MERGED')
    return merged.length ? { kind: 'merged', prs: nums(merged), why: 'merged' } : null
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
  | 'approved'
  | 'changes'
  | 'ci-failing'
  | 'ready'
  | 'in-review'
  | 'idle'
  | 'suspended'
  | 'done'

export const STATUS_TEXT: Record<StatusKey, string> = {
  'needs-input': 'Needs Input',
  working: 'Working',
  question: 'Question',
  blocked: 'Blocked',
  merged: 'Merged',
  approved: 'Approved',
  changes: 'Changes Requested',
  'ci-failing': 'CI Failing',
  ready: 'Ready for Review',
  'in-review': 'In Review',
  idle: 'Idle',
  suspended: 'Suspended',
  done: 'Ended',
}

/** The latest question or blocker master holds for this session (by its name, or its issue). */
export function attentionFor(s: Session, proposals: Proposal[]): Proposal | null {
  const mine = proposals
    .filter((p) => p.kind !== 'CHAT' && (p.status === 'question' || p.status === 'blocked'))
    .filter((p) => p.target.session === s.name || p.target.spawn?.name === s.name || (s.issue !== null && p.issue === s.issue))
  return mine.sort((a, b) => b.id - a.id)[0] ?? null
}

/**
 * A session's status, first match wins: needs input, working, question, blocked, then where its PR
 * stands, then idle. Suspended and ended sessions keep those.
 */
export function sessionStatus(s: Pick<Session, 'state'>, stage: PrStage | null | undefined, attention: Proposal | null): { key: StatusKey; text: string; why: string } {
  const out = (key: StatusKey, why = '') => ({ key, text: STATUS_TEXT[key], why })
  if (s.state === 'needs-input') return out('needs-input', 'waiting on a prompt or permission')
  if (s.state === 'working') return out('working')
  if (s.state === 'suspended' || s.state === 'done') return out(s.state)
  if (attention?.status === 'question') return out('question', attention.note?.trim() || 'it asked master a question')
  if (attention?.status === 'blocked') return out('blocked', attention.note?.trim() || 'it reported a blocker')
  if (stage) return out(stage.kind, `PR ${stage.prs.map((n) => `#${n}`).join(', ')}: ${stage.why}`)
  return out('idle')
}
