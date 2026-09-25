import { getConfig } from '@shared/appConfig'
import { buildPrSummary, parsePrUrl, type PrSummary } from '@shared/prSummary'
import type { CliResult } from '@shared/types'
import type { GhRunner } from './ghc'
import { CLOSED_MAX, TEAM_PR_CLOSED_QUERY, TEAM_PR_QUERY, teamPrSearches } from '@shared/teamPrs'
import type { Runner } from './run'

/** REST path of the configured issue repo. */
const issueRepoPath = (): string => `repos/${getConfig().owner}/${getConfig().issueRepo}`
const LOGIN = /^[A-Za-z0-9-]{1,39}$/

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** GitHub over REST (`gh api`), which has its own budget, separate from the GraphQL one the board uses. */
export class GitHub {
  private gh: GhRunner

  /** Calls go through the shared cache (ghc) when given; writes pass straight through it. */
  constructor(run: Runner, gh?: GhRunner) {
    this.gh = gh ?? ((args, opts) => run('gh', args, opts))
  }

  private api(args: string[], ttl = 120, force = false) {
    return this.gh(['api', ...args], { timeoutMs: 30_000, ttl, force })
  }

  async me(): Promise<string | null> {
    const r = await this.api(['user', '--jq', '.login'], 3600)
    const login = r.stdout.trim()
    return r.code === 0 && LOGIN.test(login) ? login : null
  }

  async assignableUsers(force = false): Promise<string[] | null> {
    const r = await this.api([`${issueRepoPath()}/assignees?per_page=100`, '--paginate', '--jq', '.[].login'], 600, force)
    if (r.code !== 0) return null
    return r.stdout.split('\n').map((l) => l.trim()).filter((l) => LOGIN.test(l))
  }

  async prSummary(url: string): Promise<{ ok: true; pr: PrSummary } | { ok: false; message: string }> {
    const id = parsePrUrl(url)
    if (!id) return { ok: false, message: `not a PR URL: ${url}` }
    const base = `repos/${id.owner}/${id.repo}`
    const pull = await this.api([`${base}/pulls/${id.number}`])
    if (pull.code !== 0) return { ok: false, message: (pull.stderr || pull.stdout).trim().slice(0, 300) }
    const p = json(pull.stdout) as { head?: { sha?: string } } | null
    const sha = p?.head?.sha
    const [reviews, checks] = await Promise.all([
      this.api([`${base}/pulls/${id.number}/reviews?per_page=100`]),
      sha ? this.api([`${base}/commits/${sha}/check-runs?per_page=100`]) : Promise.resolve({ code: 1, stdout: '', stderr: '' }),
    ])
    const pr = buildPrSummary(url, p, reviews.code === 0 ? json(reviews.stdout) : [], checks.code === 0 ? json(checks.stdout) : {})
    return pr ? { ok: true, pr } : { ok: false, message: 'unexpected PR data from GitHub' }
  }

  /**
   * Every open PR in the org (up to 300), plus the latest closed in the last 30 days (up to 300): raw GraphQL search pages.
   * About 6 points a page; read through the shared cache for 5 minutes.
   */
  async teamPrPages(owner = getConfig().owner, now = Date.now(), force = false): Promise<{ ok: true; pages: unknown[]; partial?: string } | { ok: false; message: string }> {
    if (!owner) return { ok: false, message: 'GitHub is not set up yet (Settings → GitHub & board)' }
    const { open, closed } = teamPrSearches(owner, now, undefined, getConfig().ownerType === 'user' ? 'user' : 'org')
    const pages: unknown[] = []
    let partial: string | undefined
    for (const [q, query, maxPages] of [[open, TEAM_PR_QUERY, 3], [closed, TEAM_PR_CLOSED_QUERY, CLOSED_MAX / 100]] as const) {
      let after: string | null = null
      for (let i = 0; i < maxPages; i++) {
        const args = ['graphql', '-f', `q=${q}`, '-f', `query=${query}`, ...(after ? ['-f', `after=${after}`] : [])]
        let r = await this.api(args, 300, force)
        // GitHub's search sometimes times out (HTTP 502/504); one retry usually gets through.
        if (r.code !== 0 && /HTTP 50[234]/.test(r.stderr)) r = await this.api(args, 300, force)
        const page = r.code === 0 ? (json(r.stdout) as { data?: { search?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string } } }; errors?: { message?: string }[] } | null) : null
        if (!page?.data?.search) {
          const msg = (r.stderr || page?.errors?.[0]?.message || r.stdout || 'no data').trim().slice(0, 300)
          // Keep what the open search found when only the closed one fails.
          if (pages.length) {
            partial = `closed PRs not loaded: ${msg}`
            break
          }
          return { ok: false, message: msg }
        }
        pages.push(page)
        const info = page.data.search.pageInfo
        if (!info?.hasNextPage || !info.endCursor) break
        after = info.endCursor
      }
    }
    return { ok: true, pages, partial }
  }

  /** Make `login` the only assignee of <owner>/<issueRepo>#issue. */
  async assign(issue: number, login: string, current: string[]): Promise<CliResult> {
    if (!Number.isInteger(issue) || issue <= 0) return { ok: false, message: 'bad issue number' }
    if (!LOGIN.test(login)) return { ok: false, message: `bad user: ${login}` }
    const drop = current.filter((u) => u !== login && LOGIN.test(u))
    if (drop.length) {
      const r = await this.api(['-X', 'DELETE', `${issueRepoPath()}/issues/${issue}/assignees`, ...drop.flatMap((u) => ['-f', `assignees[]=${u}`])])
      if (r.code !== 0) return { ok: false, message: `could not remove ${drop.join(', ')}: ${(r.stderr || r.stdout).trim().slice(0, 200)}` }
    }
    if (!current.includes(login)) {
      const r = await this.api(['-X', 'POST', `${issueRepoPath()}/issues/${issue}/assignees`, '-f', `assignees[]=${login}`])
      if (r.code !== 0) return { ok: false, message: `could not assign ${login}: ${(r.stderr || r.stdout).trim().slice(0, 200)}` }
    }
    return { ok: true, message: `#${issue} assigned to ${login}` }
  }
}
