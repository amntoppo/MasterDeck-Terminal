// Sub-issue rows rendered to static markup (no browser): closed and open, the detail's parts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { subIssueRows, type SubIssue } from '@shared/subIssues'
import { ticketKey } from '@shared/ticket'

const g = globalThis as Record<string, unknown>
let mod: typeof import('./SubIssues')
let details: typeof import('./GitHubDetails')
beforeAll(async () => {
  g.localStorage = { getItem: () => null, setItem: () => {} }
  g.window ??= { deck: { platform: 'darwin' }, addEventListener: () => {}, removeEventListener: () => {} }
  g.document ??= { body: {} }
  mod = await import('./SubIssues')
  details = await import('./GitHubDetails')
})

const sub = (number: number, over: Partial<SubIssue> = {}): SubIssue => ({
  repo: null, number, title: `Title ${number}`, url: `https://github.com/acme/web/issues/${number}`, state: 'open',
  body: '', bodyCut: false, assignees: [], labels: [], ...over,
})
const BODY = '## Steps\n\n- [x] done one\n- [ ] next one\n\n```\nnpm test\n```\n\nSee [spec](https://github.com/acme/web/issues/9).'
const rows = (...s: SubIssue[]) => subIssueRows(s)
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('SubIssueDetail', () => {
  it('renders the description as Markdown with status, assignees, labels and a GitHub link', () => {
    const [row] = rows(sub(5, { body: BODY, assignees: ['alice', 'bob-work'], labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: null }] }))
    const out = html(createElement(mod.SubIssueDetail, { row, id: 'd5' }))
    expect(out).toContain('id="d5"')
    expect(out).toMatch(/<h2[^>]*>Steps<\/h2>/)
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('<pre')
    expect(out).toContain('href="https://github.com/acme/web/issues/9"')
    expect(out).toContain('Open')
    expect(out).toContain('@alice')
    expect(out).toContain('@bob-work')
    expect(out).toContain('bug')
    expect(out).toContain('#d73a4a')
    expect(out).toContain('Open on GitHub')
  })
  it('says when there is no description, and when the read cut it', () => {
    expect(html(createElement(mod.SubIssueDetail, { row: rows(sub(1))[0], id: 'x' }))).toContain('No description.')
    const cut = html(createElement(mod.SubIssueDetail, { row: rows(sub(2, { body: 'abc', bodyCut: true }))[0], id: 'x' }))
    expect(cut).toContain('Cut short')
    expect(cut).not.toContain('No description.')
  })
  it('says nobody is assigned', () => {
    expect(html(createElement(mod.SubIssueDetail, { row: rows(sub(1))[0], id: 'x' }))).toContain('No one assigned')
  })
})

describe('SubIssueList (Start dialog, Assign popup)', () => {
  const list = (open: number[]) =>
    html(createElement(mod.SubIssueList, { rows: rows(sub(1, { body: 'one body' }), sub(2, { body: 'two body' })), open: new Set(open.map((n) => ticketKey(null, n))), onToggle: () => {} }))
  it('shows closed rows as buttons with aria-expanded false and no detail', () => {
    const out = list([])
    expect(out.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(out).not.toContain('one body')
    expect(out).toContain('▸')
    expect(out).not.toContain('aria-controls')
  })
  it('opens several rows at once, each tied to its detail', () => {
    const out = list([1, 2])
    expect(out.match(/aria-expanded="true"/g)).toHaveLength(2)
    expect(out).toContain('one body')
    expect(out).toContain('two body')
    const ctl = /aria-controls="([^"]+)"/.exec(out)![1]
    expect(out).toContain(`id="${ctl}"`)
  })
  it('opens only the rows asked', () => {
    const out = list([2])
    expect(out).not.toContain('one body')
    expect(out).toContain('two body')
  })
})

describe('SubIssueItem (Details → GitHub)', () => {
  const item = (open: boolean) => html(createElement(details.SubIssueItem, { row: rows(sub(3, { body: 'three body' }))[0], open, onToggle: () => {} }))
  it('is a toggle with the link out beside it', () => {
    const closed = item(false)
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).toContain('↗')
    expect(closed).not.toContain('three body')
    expect(closed).not.toContain('aria-controls')
    const open = item(true)
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('three body')
  })
})
