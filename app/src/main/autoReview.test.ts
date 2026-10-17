import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoReview, BUSY_STALE_MS, monitorId, paneReady, START_SETTLE_MS, type ReviewPanes } from './autoReview'
import { POLL_MS, TYPING_MS } from '@shared/autoReview'
import type { RunResult } from './run'

const URL1 = 'https://github.com/acme/web/pull/12'

const node = (over: Record<string, unknown> = {}) => ({
  url: URL1, number: 12, title: 'Fix login', isDraft: false, state: 'OPEN', headRefOid: 'aaa', baseRefName: 'main', headRefName: 'fix', mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED', additions: 1, deletions: 1, changedFiles: 1, author: { login: 'bob' },
  repository: { nameWithOwner: 'acme/web', viewerDefaultMergeMethod: 'SQUASH' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  latestReviews: { nodes: [] },
  ...over,
})

function world() {
  let now = 1_000_000
  const calls: string[][] = []
  // What GitHub says: the search's PRs and each tracked PR.
  const gh = { search: [node()] as unknown[], pr: node() as Record<string, unknown> | null, merge: { code: 0, stdout: '', stderr: '' } as RunResult }
  const typed: [string, string][] = []
  const started: string[] = []
  const notices: { title: string; url: string }[] = []
  const queues: Record<string, string[]> = {}
  const pane = { id: null as string | null, ready: true }
  const panes: ReviewPanes = {
    live: () => pane.id,
    ready: () => pane.ready,
    type: (id, text) => typed.push([id, text]),
    start: (tabId, _tab, prompt) => {
      started.push(prompt)
      pane.id = `pr-review:${tabId}:auto1`
      return { paneId: pane.id }
    },
  }
  const a = new AutoReview(
    join(mkdtempSync(join(tmpdir(), 'ar-')), 'auto-review.json'),
    {
      ghFor: () => async (args) => {
        calls.push(args)
        if (args[0] === 'pr') return gh.merge
        const q = args.find((x) => x.startsWith('query=')) ?? ''
        const data: Record<string, unknown> = { viewer: { login: 'alice' } }
        if (q.includes('search(')) data.s = { nodes: gh.search }
        if (q.includes('t0:')) data.t0 = { pullRequest: gh.pr }
        return { code: 0, stdout: JSON.stringify({ data }), stderr: '' }
      },
      paused: () => false,
      scope: () => ({ owner: 'acme', ownerType: 'organization' }),
      panes,
      writeQueue: (tab, urls) => (queues[tab] = urls),
      notify: (n) => notices.push(n),
      onChange: () => {},
    },
    () => now,
  )
  return { a, gh, calls, typed, started, notices, queues, pane, tick: (ms: number) => (now += ms), file: '' }
}

const on = { review: true, merge: false, name: 'Mine', account: null }

describe('AutoReview', () => {
  it('switching on adds the monitor; off removes it', () => {
    const w = world()
    expect(w.a.info()).toEqual([])
    w.a.set('mine', on)
    expect(w.a.info()).toEqual([expect.objectContaining({ id: monitorId('mine'), description: 'Automate Review · Mine', sessionId: '' })])
    expect(w.a.info()[0].command).toContain('review-requested:@me')
    expect(w.a.due()).toBe(true)
    w.a.set('mine', { review: false })
    expect(w.a.info()).toEqual([])
    expect(w.a.events(monitorId('mine')).map((e) => e.text)).toEqual(['Automate Review switched off', 'Automate Review switched on'])
  })
  it('a bad tab id is refused; a browser may not turn Merge automatically on', () => {
    const w = world()
    expect(w.a.set('../x', on).ok).toBe(false)
    expect(w.a.set('mine', { ...on, merge: true }, true).ok).toBe(false)
    expect(w.a.set('mine', { ...on, merge: true }).ok).toBe(true)
    // Already on: the browser can keep it, or switch it off.
    expect(w.a.set('mine', { ...on, merge: true }, true).ok).toBe(true)
    expect(w.a.set('mine', on, true).ok).toBe(true)
    expect(w.a.view().tabs.mine.merge).toBe(false)
  })
  it('a request is sent to the running session once, when its turn is over', async () => {
    const w = world()
    w.pane.id = 'pr-review:mine:1'
    w.a.set('mine', on)
    await w.a.poll()
    expect(w.calls[0].join(' ')).toContain('q=is:pr is:open review-requested:@me archived:false sort:updated-desc org:acme')
    w.pane.ready = false
    w.a.deliver()
    expect(w.typed).toEqual([])
    w.pane.ready = true
    w.a.deliver()
    expect(w.typed).toHaveLength(1)
    expect(w.typed[0][0]).toBe('pr-review:mine:1')
    expect(w.typed[0][1]).toContain('[MasterDeck auto-review] Review acme/web#12')
    expect(w.queues.mine).toEqual([URL1])
    // Not again: on the next delivery, nor on the next poll (the request is still on GitHub).
    w.a.deliver()
    w.tick(POLL_MS)
    await w.a.poll()
    w.a.deliver()
    expect(w.typed).toHaveLength(1)
    expect(w.a.view().prs[0].status).toBe('reviewing')
  })
  it('no session running: one is started with the PR as its first message', async () => {
    const w = world()
    w.a.set('mine', on)
    await w.a.poll()
    w.a.deliver()
    expect(w.started).toHaveLength(1)
    expect(w.started[0]).toContain(URL1)
    expect(w.a.view().tabs.mine.pane).toBe('pr-review:mine:auto1')
  })
  it('comments sent and ready to merge reach Needs you; with Merge automatically on it merges', async () => {
    const w = world()
    w.pane.id = 'p'
    w.a.set('mine', on)
    await w.a.poll()
    w.a.deliver()
    // The review lands, then the PR gets approved.
    w.gh.search = []
    const reviewed = { latestReviews: { nodes: [{ state: 'COMMENTED', submittedAt: new Date(1_000_000).toISOString(), url: `${URL1}#r1`, author: { login: 'alice' }, commit: { oid: 'aaa' }, comments: { totalCount: 2 } }] } }
    w.gh.pr = node(reviewed)
    w.tick(POLL_MS)
    await w.a.poll()
    expect(w.notices.map((n) => n.title)).toEqual(['Review comments sent on acme/web#12'])
    expect(w.notices[0].url).toBe(`${URL1}#r1`)
    w.gh.pr = node({ ...reviewed, reviewDecision: 'APPROVED' })
    w.tick(POLL_MS)
    await w.a.poll()
    expect(w.notices.map((n) => n.title)).toContain('acme/web#12 is ready to merge')
    expect(w.calls.some((c) => c[0] === 'pr')).toBe(false)
    w.a.set('mine', { ...on, merge: true })
    w.tick(POLL_MS)
    await w.a.poll()
    const merge = w.calls.find((c) => c[0] === 'pr')
    expect(merge).toEqual(['pr', 'merge', URL1, '--squash', '--match-head-commit', 'aaa'])
    expect(w.notices.at(-1)?.title).toBe('Merged acme/web#12')
    expect(w.a.view().prs[0].status).toBe('merged')
  })
  it('a failed merge is told once and not tried again for that commit', async () => {
    const w = world()
    w.pane.id = 'p'
    w.a.set('mine', { ...on, merge: true })
    await w.a.poll()
    w.a.deliver()
    w.gh.search = []
    w.gh.pr = node({ reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'COMMENTED', submittedAt: new Date(1_000_000).toISOString(), url: 'r', author: { login: 'alice' }, commit: { oid: 'aaa' }, comments: { totalCount: 0 } }] } })
    w.gh.merge = { code: 1, stdout: '', stderr: 'GraphQL: Head branch was modified' }
    w.tick(POLL_MS)
    await w.a.poll()
    w.tick(POLL_MS)
    await w.a.poll()
    expect(w.calls.filter((c) => c[0] === 'pr')).toHaveLength(1)
    expect(w.notices.filter((n) => n.title.startsWith('Could not merge'))).toHaveLength(1)
    expect(w.a.view().prs[0]).toMatchObject({ status: 'merge-failed', note: 'GraphQL: Head branch was modified' })
  })
  it('nothing is decided without knowing the account', async () => {
    const w = world()
    w.a.set('mine', on)
    ;(w.a as unknown as { deps: { ghFor: unknown } }).deps.ghFor = () => async () => ({ code: 0, stdout: '{"data":{}}', stderr: '' })
    await w.a.poll()
    expect(w.a.view().prs).toEqual([])
    expect(w.a.view().tabs.mine.error).toMatch(/who this account is/)
  })
  it('keeps its switches and tracks across a restart; a merge cut short is not retried', async () => {
    const w = world()
    w.a.set('mine', on)
    await w.a.poll()
    const file = (w.a as unknown as { file: string }).file
    const b = new AutoReview(file, (w.a as unknown as { deps: never }).deps)
    b.load()
    expect(b.info()).toHaveLength(1)
    expect(b.view().prs[0]).toMatchObject({ url: URL1, status: 'queued' })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.tracks[0].status = 'merging'
    writeFileSync(file, JSON.stringify(saved))
    const c = new AutoReview(file, (w.a as unknown as { deps: never }).deps)
    c.load()
    expect(c.view().prs[0]).toMatchObject({ status: 'merge-failed', note: expect.stringContaining('stopped during the merge') })
  })
  it('forget drops a closed tab', async () => {
    const w = world()
    w.a.set('mine', on)
    await w.a.poll()
    w.a.forget('mine')
    expect(w.a.info()).toEqual([])
    expect(w.a.view().prs).toEqual([])
  })
})

describe('paneReady', () => {
  const now = 10_000_000
  it('idle after the last line, and the user not typing', () => {
    expect(paneReady({ value: 'idle\n', at: now - 5_000 }, now - 60_000, 0, '', now)).toBe(true)
    // Still the idle from before the last line.
    expect(paneReady({ value: 'idle', at: now - 70_000 }, now - 60_000, 0, '', now)).toBe(false)
    expect(paneReady({ value: 'idle', at: now - 5_000 }, 0, now - TYPING_MS + 1, '', now)).toBe(false)
    expect(paneReady(null, 0, 0, '', now)).toBe(false)
  })
  it('a start settles first; busy only when long stale and nothing runs on screen', () => {
    expect(paneReady({ value: 'start', at: now - 1_000 }, 0, 0, '', now)).toBe(false)
    expect(paneReady({ value: 'start', at: now - START_SETTLE_MS }, 0, 0, '', now)).toBe(true)
    expect(paneReady({ value: 'busy', at: now - 1_000 }, 0, 0, '', now)).toBe(false)
    expect(paneReady({ value: 'busy', at: now - BUSY_STALE_MS - 1 }, 0, 0, 'esc to interrupt', now)).toBe(false)
    expect(paneReady({ value: 'busy', at: now - BUSY_STALE_MS - 1 }, 0, 0, '> ', now)).toBe(true)
  })
})
