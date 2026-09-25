import { getConfig } from './appConfig'
import { sessionForIssue } from './derive'
import type { Pr, Proposal, Session } from './types'

export interface PrOffer {
  id: string
  pr: Pr
  kind: 'ci' | 'review'
  /** The session that owns the PR (made it, or owns its issue). */
  owner: Session | null
  /** master's matching REVIEW/CI proposal, when it made one. */
  proposal: Proposal | null
  /** What to send the owner (master's wording). */
  message: string
}

const REPLY = (n: number) =>
  `When you are done, blocked or have a question, tell master-agent with SendMessage. First line: '#${n}: done', '#${n}: blocked — <reason>' or '#${n}: question — <question>'.`

export function ownerOf(pr: Pr, sessions: Session[], sessionPrs: Record<string, string[]>): Session | null {
  const byPr = sessions.find((s) => s.state !== 'done' && (sessionPrs[s.sessionId] ?? []).includes(pr.url))
  if (byPr) return byPr
  return pr.refsIssue !== null ? sessionForIssue(sessions, pr.refsIssue) : null
}

export function ciMessage(pr: Pr): string {
  const n = pr.refsIssue ?? 0
  return `#${n}: CI is failing on ${pr.repo}#${pr.number}\n\nPR: ${pr.url}\nFind the failing check with \`gh pr checks ${pr.number} --repo ${getConfig().owner}/${pr.repo}\`, fix it, and push. Do not merge.\n\n${REPLY(n)}`
}

export function reviewMessage(pr: Pr): string {
  const n = pr.refsIssue ?? 0
  const k = pr.unresolvedThreads
  return `#${n}: address ${k} unresolved review thread${k === 1 ? '' : 's'} on ${pr.repo}#${pr.number}\n\nPR: ${pr.url}\nRead each unresolved thread, fix what is valid, reply, and resolve it. Do not merge.\n\n${REPLY(n)}`
}

function matching(p: Proposal, pr: Pr, kind: 'CI' | 'REVIEW'): boolean {
  return p.kind === kind && p.status === 'proposed' && (p.summary.includes(`${pr.repo}#${pr.number}`) || p.message.includes(pr.url))
}

/**
 * Offers for my PRs that need their session: failing CI, or unresolved review threads. Each is
 * matched to master's proposal when there is one. `dismissed` holds offer ids the user waved off
 * (the id changes when the situation changes: a new thread count or a new failure).
 */
export function prOffers(prs: Pr[], sessions: Session[], sessionPrs: Record<string, string[]>, proposals: Proposal[], dismissed: Set<string>): PrOffer[] {
  const out: PrOffer[] = []
  for (const pr of prs) {
    const owner = ownerOf(pr, sessions, sessionPrs)
    if (pr.ci === 'failure' || pr.ci === 'error') {
      const id = `ci:${pr.url}`
      if (!dismissed.has(id)) out.push({ id, pr, kind: 'ci', owner, proposal: proposals.find((p) => matching(p, pr, 'CI')) ?? null, message: ciMessage(pr) })
    }
    if (pr.unresolvedThreads > 0) {
      const id = `review:${pr.url}:${pr.unresolvedThreads}`
      if (!dismissed.has(id)) out.push({ id, pr, kind: 'review', owner, proposal: proposals.find((p) => matching(p, pr, 'REVIEW')) ?? null, message: reviewMessage(pr) })
    }
  }
  return out
}
