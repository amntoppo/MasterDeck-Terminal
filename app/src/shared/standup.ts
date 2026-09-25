export interface StandupCommit {
  repo: string
  sha: string
  subject: string
  branch: string | null
  issue: number | null
}

export interface StandupPr {
  url: string
  repo: string
  number: number
  title: string
  issue: number | null
}

export interface StandupReport {
  issue: number
  status: string
  note: string
}

/** The standup window: since yesterday 00:00, or since Friday 00:00 on a Monday. */
export function standupSince(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const back = now.getDay() === 1 ? 3 : 1
  d.setDate(d.getDate() - back)
  return d
}

/** Issue number from a branch name like feat/1036-popup or 1021-birthday. */
export function issueFromBranch(branch: string | null): number | null {
  const m = /(?:^|[/_-])(\d{2,5})(?:[-_]|$)/.exec(branch ?? '')
  return m ? Number(m[1]) : null
}

/** Markdown grouped by ticket; "Other" for work without one. */
export function standupMarkdown(since: Date, titles: Record<number, string>, commits: StandupCommit[], prs: StandupPr[], reports: StandupReport[]): string {
  const keys = new Set<number | null>([...commits.map((c) => c.issue), ...prs.map((p) => p.issue), ...reports.map((r) => r.issue)])
  const order = [...keys].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b))
  const out = [`### Standup (since ${since.toDateString()})`, '']
  if (order.length === 0) out.push('_Nothing recorded since then._')
  for (const k of order) {
    out.push(k === null ? '**Other**' : `**#${k} ${titles[k] ?? ''}**`.replace(/ \*\*$/, '**'))
    for (const r of reports.filter((x) => x.issue === k)) out.push(`- Session reported **${r.status}**: ${r.note.split('\n')[0]}`)
    for (const p of prs.filter((x) => x.issue === k)) out.push(`- PR ${p.repo}#${p.number}: ${p.title}`)
    const cs = commits.filter((x) => x.issue === k)
    if (cs.length) out.push(`- ${cs.length} commit${cs.length === 1 ? '' : 's'}: ${cs.slice(0, 5).map((c) => `${c.subject} (${c.repo}@${c.sha.slice(0, 7)})`).join('; ')}${cs.length > 5 ? '; …' : ''}`)
    out.push('')
  }
  return out.join('\n').trim()
}

export interface TicketPoints {
  issue: number | null
  title: string
  points: string[]
}

/** Shorten to at most n characters, at a word boundary when there is one. */
const clip = (s: string, n: number) => {
  if (s.length <= n) return s
  const cut = s.slice(0, n - 1)
  const space = cut.lastIndexOf(' ')
  const head = (space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')
  // Don't end on a dangling little word ("reset banner state on…").
  return `${head.replace(/\s+(a|an|and|or|the|to|of|on|in|for|with|at|by|from|as)$/i, '')}…`
}

/** A commit subject without its conventional prefix and ticket reference: "feat(home): add X (tracker#968)" → "add X". */
export function cleanSubject(subject: string): string {
  return subject
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')
    .replace(/\s*\((?:[\w.-]+\/)?(?:[\w.-]+)?#\d+\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The gist of a session report, short enough to say out loud: its first sentence, plus the next
 * one when the first is only a word or two ("Live. Backend #605 is on dev2").
 */
function firstSentence(note: string): string {
  const text = note.split('\n').filter((l) => l.trim()).join(' ').trim()
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text]
  let out = sentences[0] ?? ''
  if (out.length < 25 && sentences[1]) out = `${out.replace(/[.!?]$/, '')}. ${sentences[1]}`
  return clip(out.replace(/[.]$/, ''), 110)
}

/**
 * Crisp talking points per ticket: what finished or is stuck (session reports), PRs that went up,
 * and one line of what the commits were about. Tickets with the most to say come first; work
 * without a ticket goes last under "Other".
 */
export function standupPoints(titles: Record<number, string>, commits: StandupCommit[], prs: StandupPr[], reports: StandupReport[]): TicketPoints[] {
  const keys = new Set<number | null>([...commits.map((c) => c.issue), ...prs.map((p) => p.issue), ...reports.map((r) => r.issue)])
  const out: TicketPoints[] = []
  for (const k of keys) {
    const points: string[] = []
    const rs = reports.filter((r) => r.issue === k)
    const done = rs.find((r) => r.status === 'done')
    const blocked = rs.find((r) => r.status === 'blocked')
    const question = rs.find((r) => r.status === 'question')
    if (done) points.push(`Done: ${firstSentence(done.note)}`)
    if (blocked) points.push(`Blocked: ${firstSentence(blocked.note)}`)
    if (question) points.push(`Waiting on my input: ${firstSentence(question.note)}`)
    const ps = prs.filter((p) => p.issue === k)
    if (ps.length === 1) points.push(`PR up: ${ps[0].repo}#${ps[0].number}, ${clip(ps[0].title, 70)}`)
    else if (ps.length > 1) points.push(`${ps.length} PRs up: ${ps.map((p) => `${p.repo}#${p.number}`).join(', ')}`)
    const subjects = [
      ...new Set(
        commits
          .filter((c) => c.issue === k && !/^Merge\b/i.test(c.subject))
          .map((c) => cleanSubject(c.subject))
          .filter(Boolean),
      ),
    ]
    // One short bullet per piece of work (easier to say than a run-on list), at most three.
    subjects.slice(0, 3).forEach((s, i) => points.push(i === 0 ? `Worked on: ${clip(s, 60)}` : clip(s, 60)))
    if (subjects.length > 3) points.push(`+${subjects.length - 3} more commit${subjects.length - 3 === 1 ? '' : 's'}`)
    if (points.length) out.push({ issue: k, title: k === null ? 'Other' : clip(titles[k] ?? `#${k}`, 70), points })
  }
  return out.sort((a, b) => (a.issue === null ? 1 : b.issue === null ? -1 : b.points.length - a.points.length || a.issue - b.issue))
}

/** Plain bullets for copying (to read out, or paste into chat). */
export function pointsText(label: string, tickets: TicketPoints[]): string {
  if (tickets.length === 0) return `Standup (${label}): nothing recorded.`
  return [`Standup (${label})`, ...tickets.flatMap((t) => ['', t.issue === null ? 'Other' : `#${t.issue} ${t.title}`, ...t.points.map((p) => `• ${p}`)])].join('\n')
}

export type StandupRange = 'last-standup' | 'yesterday' | '3d' | 'week' | 'custom'

/** [since, until) for a preset, relative to `now`. */
export function rangeFor(r: StandupRange, now: Date): { since: Date; until: Date } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const daysAgo = (n: number) => new Date(midnight.getTime() - n * 86_400_000)
  if (r === 'yesterday') return { since: daysAgo(1), until: midnight }
  if (r === '3d') return { since: daysAgo(3), until: now }
  if (r === 'week') return { since: daysAgo((now.getDay() + 6) % 7), until: now }
  return { since: standupSince(now), until: now }
}
