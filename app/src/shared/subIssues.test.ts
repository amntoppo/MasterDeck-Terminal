import { describe, expect, it } from 'vitest'
import { parseSubIssues, subIssueProgress, subIssueRows, type SubIssue } from './subIssues'
import type { BoardCard } from './types'

const line = (o: object) => JSON.stringify(o)

describe('parseSubIssues', () => {
  it('reads one sub-issue per line, the primary repo as null, another repo as owner/name', () => {
    const out = [
      line({ number: 5, title: 'Keep the cookie', state: 'closed', url: 'https://github.com/acme/tracker/issues/5', repo: 'acme/tracker' }),
      line({ number: 6, title: 'Show the error', state: 'open', url: 'https://github.com/acme/web/issues/6', repo: 'acme/web' }),
      '',
    ].join('\n')
    expect(parseSubIssues(out)).toEqual([
      { repo: null, number: 5, title: 'Keep the cookie', state: 'closed', url: 'https://github.com/acme/tracker/issues/5' },
      { repo: 'acme/web', number: 6, title: 'Show the error', state: 'open', url: 'https://github.com/acme/web/issues/6' },
    ])
  })
  it("skips malformed lines, takes the parent's repo when none is given, and drops a URL that is not GitHub's", () => {
    const out = ['not json', line({ title: 'no number' }), line({ number: 7, title: 'x', state: 'open', url: 'javascript:alert(1)', repo: '' })].join('\n')
    expect(parseSubIssues(out, 'acme/web')).toEqual([{ repo: 'acme/web', number: 7, title: 'x', state: 'open', url: '' }])
  })
})

describe('subIssueRows', () => {
  const sub = (number: number, state: 'open' | 'closed', repo: string | null = null): SubIssue => ({ repo, number, title: `t${number}`, url: '', state })
  const card = (number: number, status: string | null, repo: string | null = null) =>
    ({ number, repo, status, title: '', url: '', prs: [], assignees: [], labels: [], milestone: null, type: null }) as BoardCard

  it("shows the board column of a sub-issue on the board, else open or closed", () => {
    const rows = subIssueRows([sub(1, 'open'), sub(2, 'closed'), sub(3, 'open', 'acme/web'), sub(4, 'open')], [card(1, 'In Dev'), card(3, 'Todo', 'acme/web'), card(4, null)])
    expect(rows.map((r) => r.status)).toEqual(['In Dev', 'Closed', 'Todo', 'Open'])
  })
  it('does not mix up the same number in two repositories', () => {
    expect(subIssueRows([sub(9, 'open', 'acme/web')], [card(9, 'Done')])[0].status).toBe('Open')
  })
  it('counts closed sub-issues as done', () => {
    const rows = subIssueRows([sub(1, 'closed'), sub(2, 'open'), sub(3, 'closed'), sub(4, 'open'), sub(5, 'open')])
    expect(subIssueProgress(rows)).toBe('2 / 5 done')
  })
})
