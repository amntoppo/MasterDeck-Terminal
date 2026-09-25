export interface PrSummary {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  author: string
  /** OPEN, DRAFT, MERGED, CLOSED */
  state: string
  base: string
  head: string
  additions: number
  deletions: number
  changedFiles: number
  body: string
  /** Latest review state per reviewer. */
  reviews: { user: string; state: string }[]
  checks: { passed: number; failed: number; pending: number; total: number }
}

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(url)
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null
}

type J = Record<string, unknown>
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const n = (v: unknown) => (typeof v === 'number' ? v : 0)
const s = (v: unknown) => (typeof v === 'string' ? v : '')

/** REST `pulls/{n}`, `pulls/{n}/reviews` and `commits/{sha}/check-runs` into one summary. */
export function buildPrSummary(url: string, pull: unknown, reviews: unknown, checkRuns: unknown): PrSummary | null {
  const id = parsePrUrl(url)
  const p = o(pull)
  if (!id || typeof p.number !== 'number') return null
  const state = p.merged === true || p.merged_at ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : p.draft === true ? 'DRAFT' : 'OPEN'
  const latest = new Map<string, string>()
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const user = s(o(o(r).user).login)
    const st = s(o(r).state)
    if (user && st && st !== 'PENDING') latest.set(user, st)
  }
  const runs = Array.isArray(o(checkRuns).check_runs) ? (o(checkRuns).check_runs as unknown[]) : []
  let passed = 0
  let failed = 0
  let pending = 0
  for (const r of runs.map(o)) {
    if (r.status !== 'completed') pending++
    else if (['success', 'neutral', 'skipped'].includes(s(r.conclusion))) passed++
    else failed++
  }
  return {
    url,
    ...id,
    title: s(p.title),
    author: s(o(p.user).login),
    state,
    base: s(o(p.base).ref),
    head: s(o(p.head).ref),
    additions: n(p.additions),
    deletions: n(p.deletions),
    changedFiles: n(p.changed_files),
    body: s(p.body),
    reviews: [...latest].map(([user, st]) => ({ user, state: st })),
    checks: { passed, failed, pending, total: runs.length },
  }
}
