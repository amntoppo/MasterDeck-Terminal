import type { PrLive } from './types'

/**
 * "Ready for Review": a session whose PR is open and has had no new comments or reviews for a
 * while (Settings, 20 minutes by default). The timer starts when the PR is created and starts
 * again at each new comment or review, from anyone.
 */
export interface ReviewTimer {
  /** The open PRs it watches (numbers). */
  prs: number[]
  /** The PR's creation or its last comment or review, whichever is latest (ms). */
  since: number
  /** When it counts as ready (ms). */
  readyAt: number
  ready: boolean
}

export function reviewTimer(urls: string[], live: Record<string, PrLive>, now: number, quietMinutes: number): ReviewTimer | null {
  // Drafts count: sessions open their PRs as drafts, and quiet means ready for you to look at it.
  // Merged and closed PRs are past review.
  const open = urls.map((u) => live[u]).filter((p): p is PrLive => !!p && p.state === 'OPEN')
  const times = open.flatMap((p) => [p.createdAt, p.lastCommentAt]).filter((t): t is number => typeof t === 'number')
  if (!times.length) return null
  const since = Math.max(...times)
  const readyAt = since + quietMinutes * 60_000
  return { prs: open.map((p) => p.number), since, readyAt, ready: now >= readyAt }
}

/** The session's PRs are all merged: none open (drafts included), and at least one merged. Their numbers. */
export function mergedPrs(urls: string[], live: Record<string, PrLive>): number[] | null {
  const prs = urls.map((u) => live[u]).filter((p): p is PrLive => !!p)
  if (prs.some((p) => p.state === 'OPEN')) return null
  const merged = prs.filter((p) => p.state === 'MERGED').map((p) => p.number)
  return merged.length ? merged : null
}

export type StatusDot = 'working' | 'idle' | 'needs-input' | 'suspended' | 'done' | 'review' | 'merged'

/**
 * What a session's status says, in the sidebar and its header: needs input and working first;
 * then, instead of "idle", where its PR stands: merged, ready for review, or the time left.
 */
export function sessionStatus(
  state: string,
  review: ReviewTimer | null | undefined,
  merged: number[] | null | undefined,
  now: number,
): { text: string; dot: StatusDot; countdown: number | null } {
  if (state !== 'idle') return { text: STATE_TEXT[state] ?? state, dot: (state in STATE_TEXT ? state : 'idle') as StatusDot, countdown: null }
  if (merged?.length) return { text: 'merged', dot: 'merged', countdown: null }
  if (review?.ready) return { text: 'ready for review', dot: 'review', countdown: null }
  if (review) return { text: 'review in', dot: 'idle', countdown: review.readyAt - now }
  return { text: 'idle', dot: 'idle', countdown: null }
}

const STATE_TEXT: Record<string, string> = {
  working: 'working',
  idle: 'idle',
  'needs-input': 'needs input',
  suspended: 'suspended',
  done: 'ended',
}
