import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fitSubIssues, parseSubIssues, SUB_BODY_MAX, SUB_ISSUES_JQ, subIssueProgress, subIssueRows, type SubIssue } from './subIssues'
import type { BoardCard } from './types'

const line = (o: object) => JSON.stringify(o)
const EMPTY = { body: '', bodyCut: false, assignees: [], labels: [] }

describe('parseSubIssues', () => {
  it('reads one sub-issue per line, the primary repo as null, another repo as owner/name', () => {
    const out = [
      line({ number: 5, title: 'Keep the cookie', state: 'closed', url: 'https://github.com/acme/tracker/issues/5', repo: 'acme/tracker' }),
      line({ number: 6, title: 'Show the error', state: 'open', url: 'https://github.com/acme/web/issues/6', repo: 'acme/web' }),
      '',
    ].join('\n')
    expect(parseSubIssues(out)).toEqual([
      { repo: null, number: 5, title: 'Keep the cookie', state: 'closed', url: 'https://github.com/acme/tracker/issues/5', ...EMPTY },
      { repo: 'acme/web', number: 6, title: 'Show the error', state: 'open', url: 'https://github.com/acme/web/issues/6', ...EMPTY },
    ])
  })
  it("skips malformed lines, takes the parent's repo when none is given, and drops a URL that is not GitHub's", () => {
    const out = ['not json', line({ title: 'no number' }), line({ number: 7, title: 'x', state: 'open', url: 'javascript:alert(1)', repo: '' })].join('\n')
    expect(parseSubIssues(out, 'acme/web')).toEqual([{ repo: 'acme/web', number: 7, title: 'x', state: 'open', url: '', ...EMPTY }])
  })
  it('keeps the description, assignees and labels', () => {
    const out = line({
      number: 8, title: 'Export', state: 'open', url: 'https://github.com/acme/web/issues/8', repo: 'acme/web',
      body: '## Steps\r\n\r\n- [ ] one', bodyCut: false, assignees: ['alice', 'bob-work'],
      labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'good first issue', color: '7057FF' }],
    })
    expect(parseSubIssues(out)[0]).toMatchObject({
      body: '## Steps\n\n- [ ] one', bodyCut: false, assignees: ['alice', 'bob-work'],
      labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'good first issue', color: '7057ff' }],
    })
  })
  it('empties a malformed field without dropping the sub-issue', () => {
    const out = line({
      number: 9, title: 'x', state: 'open', url: '', repo: 'acme/web',
      body: 42, bodyCut: 'yes', assignees: ['ok', 'not a login', 7], labels: [{ name: 'a', color: 'red' }, { color: 'ffffff' }, 'b'],
    })
    expect(parseSubIssues(out)).toEqual([
      { repo: 'acme/web', number: 9, title: 'x', state: 'open', url: '', body: '', bodyCut: false, assignees: ['ok'], labels: [{ name: 'a', color: null }] },
    ])
    expect(parseSubIssues(line({ number: 9, title: 'x', state: 'open', assignees: 'alice', labels: {} }))[0]).toMatchObject(EMPTY)
  })
  it('keeps a bot or app assignee', () => {
    expect(parseSubIssues(line({ number: 1, title: 'x', state: 'open', assignees: ['some-app[bot]', 'bad[bot'] }))[0].assignees).toEqual(['some-app[bot]'])
  })
  it('marks a description the read cut', () => {
    expect(parseSubIssues(line({ number: 1, title: 'x', state: 'open', body: 'abc', bodyCut: true }))[0].bodyCut).toBe(true)
  })
})

describe('SUB_ISSUES_JQ', () => {
  const hasJq = (() => {
    try {
      execFileSync('jq', ['--version'])
      return true
    } catch {
      return false
    }
  })()
  it.skipIf(!hasJq)('runs on a REST answer: a null body, a long one, null assignees and labels', () => {
    const answer = [
      { number: 1, title: 'a', state: 'open', html_url: 'https://github.com/acme/web/issues/1', repository_url: 'https://api.github.com/repos/acme/web', body: null, assignees: null, labels: null },
      { number: 2, title: 'b', state: 'closed', html_url: 'https://github.com/acme/web/issues/2', repository_url: null, body: 'é'.repeat(SUB_BODY_MAX + 5), assignees: [{ login: 'alice' }], labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'x' }] },
    ]
    const out = execFileSync('jq', ['-c', SUB_ISSUES_JQ], { input: JSON.stringify(answer) }).toString()
    const [a, b] = parseSubIssues(out)
    expect(a).toMatchObject({ number: 1, repo: 'acme/web', body: '', bodyCut: false, assignees: [], labels: [] })
    expect(b).toMatchObject({ number: 2, state: 'closed', bodyCut: true, assignees: ['alice'], labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'x', color: null }] })
    expect(b.body).toHaveLength(SUB_BODY_MAX)
  }, 20_000)

  it('cuts the description at SUB_BODY_MAX and keeps assignees and labels', () => {
    expect(SUB_ISSUES_JQ).toContain(`.[0:${SUB_BODY_MAX}]`)
    expect(SUB_ISSUES_JQ).toContain(`length > ${SUB_BODY_MAX}`)
    expect(SUB_ISSUES_JQ).toContain('assignees: [.assignees[]?.login]')
    expect(SUB_ISSUES_JQ).toContain('labels: [.labels[]? | {name, color}]')
  })
})

describe('subIssueRows', () => {
  const sub = (number: number, state: 'open' | 'closed', repo: string | null = null): SubIssue => ({ repo, number, title: `t${number}`, url: '', state, ...EMPTY })
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

describe('fitSubIssues', () => {
  const big = (number: number, n: number, ch = 'a'): SubIssue => ({ repo: null, number, title: 't', url: '', state: 'open', body: ch.repeat(n), bodyCut: false, assignees: [], labels: [] })
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
  it('leaves an answer under the budget alone', () => {
    const subs = [big(1, 100), big(2, 200)]
    expect(fitSubIssues(subs, 10_000)).toEqual(subs)
  })
  it('empties the longest descriptions first, in bytes, until the answer fits, and marks them cut', () => {
    // 3 000 three-byte characters are 9 000 bytes: longer than 5 000 ASCII ones.
    const subs = [big(1, 5000), big(2, 3000, '漢'), big(3, 100)]
    const out = fitSubIssues(subs, 7_000)
    expect(out.map((s) => [s.number, s.body.length, s.bodyCut])).toEqual([[1, 5000, false], [2, 0, true], [3, 100, false]])
    expect(bytes({ ok: true, subIssues: out })).toBeLessThanOrEqual(7_000)
  })
  it('keeps every row even when all descriptions must go', () => {
    const out = fitSubIssues([big(1, 5000), big(2, 5000)], 500)
    expect(out.map((s) => [s.number, s.body, s.bodyCut])).toEqual([[1, '', true], [2, '', true]])
  })
})
