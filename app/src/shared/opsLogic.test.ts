import { describe, expect, it } from 'vitest'
import { classifyWorktree, isCleanupTarget, needsTypedConfirm, prForBranch, repoSlug, type WorktreeInfo } from './janitor'
import { addBurnPoint, burndown, groupOf, summarize, summaryMarkdown } from './sprintSummary'
import { cleanSubject, issueFromBranch, pointsText, rangeFor, standupMarkdown, standupPoints, standupSince } from './standup'
import type { Board, BoardCard } from './types'

const card = (n: number, status: string | null, assignees: string[] = []): BoardCard => ({ number: n, title: `T${n}`, url: '', status, prs: [], assignees, labels: [], milestone: null, type: null })

describe('sprint summary', () => {
  const b: Board = { takenAt: null, sprint: 'Sprint 6', columns: [], cards: [card(1, 'Dev Done', ['a']), card(2, 'In Dev', ['a']), card(3, 'Blocked'), card(4, 'To Do', ['b']), card(5, 'In QA', ['b'])] }
  it('groups cards, a blocked badge counts as blocked', () => {
    const s = summarize(b)
    expect(s.counts).toEqual({ done: 2, progress: 1, blocked: 1, todo: 1 })
    expect(groupOf(card(9, 'In Dev'), 'blocked')).toBe('blocked')
    expect(s.byAssignee.find((r) => r.login === '(unassigned)')?.blocked).toBe(1)
  })
  it('markdown lists blocked first', () => {
    const md = summaryMarkdown('Sprint 6', summarize(b))
    expect(md.split('\n')[0]).toBe('### Sprint 6: 2/5 done, 1 in progress, 1 blocked')
    expect(md.indexOf('**Blocked')).toBeLessThan(md.indexOf('**Done'))
  })
  it('burndown keeps the latest point per day and draws the ideal line', () => {
    let h = addBurnPoint([], { date: '2026-09-21', total: 10, done: 0 })
    h = addBurnPoint(h, { date: '2026-09-22', total: 10, done: 2 })
    h = addBurnPoint(h, { date: '2026-09-22', total: 10, done: 3 })
    expect(h).toHaveLength(2)
    const bd = burndown(h, '2026-09-21', 3)
    expect(bd.map((p) => p.remaining)).toEqual([10, 7, null])
    expect(bd.map((p) => p.ideal)).toEqual([10, 5, 0])
  })
})

describe('standup', () => {
  it('window: yesterday, or Friday on a Monday', () => {
    expect(standupSince(new Date(2026, 8, 24, 10)).toDateString()).toBe(new Date(2026, 8, 23).toDateString())
    expect(standupSince(new Date(2026, 8, 28, 10)).toDateString()).toBe(new Date(2026, 8, 25).toDateString())
  })
  it('issue from branch names', () => {
    expect(issueFromBranch('feat/1036-notification-popup')).toBe(1036)
    expect(issueFromBranch('1021-birthday')).toBe(1021)
    expect(issueFromBranch('docs/chat-design')).toBeNull()
  })
  it('groups by ticket with reports, PRs and commits', () => {
    const md = standupMarkdown(new Date(2026, 8, 24), { 1036: 'Notification Pop-up' },
      [{ repo: 'mobile-app', sha: 'abcdef123', subject: 'feat: bell dropdown', branch: 'feat/1036-x', issue: 1036 }, { repo: 'r', sha: '1234567', subject: 'chore', branch: null, issue: null }],
      [{ url: 'u', repo: 'mobile-app', number: 137, title: 'Notification popup', issue: 1036 }],
      [{ issue: 1036, status: 'done', note: 'Implemented and pushed.\nmore' }])
    expect(md).toContain('**#1036 Notification Pop-up**')
    expect(md).toContain('- Session reported **done**: Implemented and pushed.')
    expect(md).toContain('- PR mobile-app#137: Notification popup')
    expect(md).toContain('- 1 commit: feat: bell dropdown (mobile-app@abcdef1)')
    expect(md).toContain('**Other**')
  })
})

const wt = (p: Partial<WorktreeInfo>): WorktreeInfo => ({ repo: '/r', path: '/r/.claude/worktrees/x', branch: 'feat/x', dirtyFiles: 0, merged: false, pushed: false, orphanCommits: 0, lastCommitAt: null, ...p })

describe('janitor', () => {
  it('classifies like the worktree-janitor skill; in use wins', () => {
    expect(classifyWorktree(wt({ dirtyFiles: 3, merged: true }), ['/r/.claude/worktrees/x/sub']).cls).toBe('IN USE')
    expect(classifyWorktree(wt({ dirtyFiles: 3, merged: true }), ['/r/.claude/worktrees/xy']).cls).toBe('DIRTY')
    expect(classifyWorktree(wt({ merged: true }), []).cls).toBe('SAFE')
    expect(classifyWorktree(wt({ branch: null }), []).cls).toBe('SAFE')
    expect(classifyWorktree(wt({ pushed: true }), []).cls).toBe('PUSHED')
    expect(classifyWorktree(wt({}), []).cls).toBe('UNPUSHED')
    expect(classifyWorktree(wt({ branch: null, orphanCommits: 2 }), []).cls).toBe('UNPUSHED')
    expect(classifyWorktree(wt({ dirtyFiles: -1, merged: true }), []).cls).toBe('DIRTY')
    expect(needsTypedConfirm('DIRTY')).toBe(true)
    expect(needsTypedConfirm('SAFE')).toBe(false)
  })
  it('a merged PR makes a clean worktree SAFE only while it sits on the merged commit', () => {
    const pr = { number: 7, state: 'MERGED' as const, url: 'u', headOid: 'abc' }
    const merged = classifyWorktree(wt({ head: 'abc', pr }), [])
    expect(merged).toEqual({ cls: 'SAFE', reason: 'PR #7 merged' })
    expect(isCleanupTarget({ ...merged, pr })).toBe(true)
    expect(classifyWorktree(wt({ head: 'def', pr }), []).cls).toBe('UNPUSHED') // work after the merge
    expect(classifyWorktree(wt({ head: 'abc', pr, dirtyFiles: 1 }), []).cls).toBe('DIRTY')
    expect(classifyWorktree(wt({ head: 'abc', pr }), ['/r/.claude/worktrees/x']).cls).toBe('IN USE')
    const open = { ...pr, state: 'OPEN' as const }
    expect(isCleanupTarget({ ...classifyWorktree(wt({ head: 'abc', pr: open, merged: true }), []), pr: open })).toBe(false)
  })
  it('picks the branch PR: open first, then the newest merged', () => {
    const list = [
      { number: 1, state: 'MERGED', headRefName: 'feat/x', headRefOid: 'a', url: 'u1' },
      { number: 5, state: 'MERGED', headRefName: 'feat/x', headRefOid: 'b', url: 'u5' },
      { number: 3, state: 'CLOSED', headRefName: 'feat/x', headRefOid: 'c', url: 'u3' },
      { number: 9, state: 'OPEN', headRefName: 'other', headRefOid: 'd', url: 'u9' },
    ]
    expect(prForBranch(list, 'feat/x')).toEqual({ number: 5, state: 'MERGED', url: 'u5', headOid: 'b' })
    expect(prForBranch([...list, { number: 6, state: 'OPEN', headRefName: 'feat/x', headRefOid: 'e', url: 'u6' }], 'feat/x')?.number).toBe(6)
    expect(prForBranch(list, null)).toBeNull()
    expect(prForBranch(null, 'feat/x')).toBeNull()
  })
  it('reads owner/repo from origin URLs', () => {
    expect(repoSlug('git@github.com:acme/web-app.git\n')).toBe('acme/web-app')
    expect(repoSlug('git@github.com-work:acme/web-app.git')).toBe('acme/web-app')
    expect(repoSlug('https://github.com/acme/web-app')).toBe('acme/web-app')
    expect(repoSlug('https://gitlab.com/acme/web-app.git')).toBeNull()
  })
})

describe('standup points', () => {
  it('cleans commit subjects', () => {
    expect(cleanSubject('feat(home): add analytics banner events (tracker#968)')).toBe('add analytics banner events')
    expect(cleanSubject('fix!: handle null')).toBe('handle null')
    expect(cleanSubject('Plain subject')).toBe('Plain subject')
  })
  it('crisp points per ticket: done/blocked/question, PRs, what the commits were about', () => {
    const pts = standupPoints(
      { 988: 'Expo public link fix', 941: 'Home page banners' },
      [
        { repo: 'mobile-app', sha: 'a', subject: 'fix(links): accept an emailed org invitation in the app', branch: 'fix/988-x', issue: 988 },
        { repo: 'mobile-app', sha: 'b', subject: 'fix(web): a branded not-found screen', branch: 'fix/988-x', issue: 988 },
        { repo: 'r', sha: 'c', subject: 'chore: tidy', branch: null, issue: null },
      ],
      [{ url: 'u', repo: 'mobile-app', number: 117, title: 'Public links', issue: 988 }],
      [
        { issue: 988, status: 'done', note: 'Live. Backend #605 is on staging.\nmore' },
        { issue: 941, status: 'question', note: 'Should the banner hide after 3 dismissals?' },
      ],
    )
    expect(pts[0]).toEqual({
      issue: 988,
      title: 'Expo public link fix',
      points: ['Done: Live. Backend #605 is on staging', 'PR up: mobile-app#117, Public links', 'Worked on: accept an emailed org invitation in the app', 'a branded not-found screen'],
    })
    expect(pts[1].points).toEqual(['Waiting on my input: Should the banner hide after 3 dismissals?'])
    expect(pts.at(-1)?.title).toBe('Other')
    expect(pointsText('yesterday', pts).split('\n')[2]).toBe('#988 Expo public link fix')
  })
  it('skips merge commits and cuts long items at a word boundary', () => {
    const pts = standupPoints({ 1: 'T' }, [
      { repo: 'r', sha: 'm', subject: 'Merge origin/main into feat/1-x', branch: null, issue: 1 },
      { repo: 'r', sha: 'a', subject: 'fix(home): clean up the legacy dismiss key and reset banner state on focus', branch: null, issue: 1 },
    ], [], [])
    expect(pts[0].points).toEqual(['Worked on: clean up the legacy dismiss key and reset banner state…'])
    const many = standupPoints({ 2: 'U' }, ['a one', 'b two', 'c three', 'd four', 'e five'].map((subject, i) => ({ repo: 'r', sha: String(i), subject, branch: null, issue: 2 })), [], [])
    expect(many[0].points).toEqual(['Worked on: a one', 'b two', 'c three', '+2 more commits'])
  })
  it('ranges', () => {
    const now = new Date(2026, 8, 25, 10) // a Friday
    expect(rangeFor('yesterday', now).since.toDateString()).toBe(new Date(2026, 8, 24).toDateString())
    expect(rangeFor('yesterday', now).until.toDateString()).toBe(new Date(2026, 8, 25).toDateString())
    expect(rangeFor('week', now).since.toDateString()).toBe(new Date(2026, 8, 21).toDateString())
    expect(rangeFor('3d', now).since.toDateString()).toBe(new Date(2026, 8, 22).toDateString())
  })
})
