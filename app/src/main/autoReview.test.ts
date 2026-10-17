import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoReview, BUSY_STALE_MS, monitorId, paneReady, SEND_LOST_MS, START_SETTLE_MS, type ReviewPanes } from './autoReview'
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
  const gh = { search: [node()] as unknown[], pr: node() as Record<string, unknown> | null, merge: { code: 0, stdout: '', stderr: '' } as RunResult, hold: null as Promise<void> | null, fresh: null as Record<string, unknown> | null }
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
        if (gh.hold) await gh.hold
        if (args[0] === 'pr') return gh.merge
        const q = args.find((x) => x.startsWith('query=')) ?? ''
        const data: Record<string, unknown> = { viewer: { login: 'alice' } }
        if (q.includes('search(')) data.s = { nodes: gh.search }
        // The read before a merge (no search): `fresh` when set, else the same PR.
        if (q.includes('t0:')) data.t0 = { pullRequest: !q.includes('search(') && gh.fresh ? gh.fresh : gh.pr }
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

const approvedAfter = (at: number) =>
  node({ reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'COMMENTED', submittedAt: new Date(at).toISOString(), url: 'r', author: { login: 'alice' }, commit: { oid: 'aaa' }, comments: { totalCount: 1 } }] } })

describe('AutoReview: what the review found', () => {
  /** A tab with a PR sent to its session, approved after the review, ready. */
  const readyWorld = async (merge: boolean) => {
    const w = world()
    w.pane.id = 'p'
    w.a.set('mine', { ...on, merge })
    await w.a.poll()
    w.a.deliver()
    w.gh.search = []
    w.gh.pr = approvedAfter(1_000_000)
    w.tick(POLL_MS)
    return w
  }
  it('switched off while GitHub answers: nothing is merged, nothing comes back', async () => {
    const w = await readyWorld(true)
    let release = () => {}
    w.gh.hold = new Promise((r) => (release = r))
    const p = w.a.poll()
    w.a.set('mine', { ...on, merge: false })
    w.gh.hold = null
    release()
    await p
    expect(w.calls.some((c) => c[0] === 'pr')).toBe(false)
  })
  it('a review older than the request is not the automated one', async () => {
    const w = world()
    w.pane.id = 'p'
    w.a.set('mine', { ...on, merge: true })
    await w.a.poll()
    w.a.deliver()
    w.gh.search = []
    w.gh.pr = approvedAfter(1_000) // long before it was sent
    w.tick(POLL_MS)
    await w.a.poll()
    expect(w.notices).toEqual([])
    expect(w.calls.some((c) => c[0] === 'pr')).toBe(false)
    expect(w.a.view().prs[0].status).toBe('reviewing')
  })
  it('the PR is read again past the cache before merging, and not merged if it changed', async () => {
    const w = await readyWorld(true)
    w.gh.fresh = node({ ...approvedAfter(1_000_000), commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } })
    await w.a.poll()
    expect(w.calls.some((c) => c[0] === 'pr')).toBe(false)
    expect(w.calls.some((c) => !c.join(' ').includes('search('))).toBe(true)
    expect(w.a.view().prs[0]).toMatchObject({ status: 'ready', note: 'checks are failing' })
  })
  it('switching off frees its PRs for another tab of the account, and empties the queue', async () => {
    const w = world()
    w.pane.id = 'p'
    w.a.set('mine', on)
    await w.a.poll()
    w.a.deliver()
    expect(w.queues.mine).toEqual([URL1])
    w.a.set('mine', { review: false })
    expect(w.queues.mine).toEqual([])
    expect(w.a.view().prs).toEqual([])
    w.a.set('other', { ...on, name: 'Other' })
    await w.a.poll()
    expect(w.a.view().prs[0].tabId).toBe('other')
  })
  it('a browser only flips switches: it keeps the window’s filters and account, and never forgets', () => {
    const w = world()
    w.a.set('mine', { ...on, filters: { repo: 'web' } })
    w.a.set('mine', { ...on, name: 'Web', filters: { repo: '' } }, true)
    expect(w.a.info()[0].command).toContain('repo:acme/web')
    expect(w.a.info()[0].description).toBe('Automate Review · Mine')
  })
  it('follow keeps the switches main has (a flip in between is not undone)', () => {
    const w = world()
    w.a.set('mine', { ...on, merge: true })
    w.a.set('mine', { ...on, merge: false })
    w.a.set('mine', { review: true, merge: false, follow: true, name: 'Renamed' })
    expect(w.a.view().tabs.mine.merge).toBe(false)
    expect(w.a.info()[0].description).toBe('Automate Review · Renamed')
    // Nor does it turn anything on.
    w.a.set('x', { review: true, merge: true, follow: true, name: 'X' })
    expect(w.a.view().tabs.x).toBeUndefined()
  })
  it('a review pane is not started again and again', async () => {
    const w = world()
    w.a.set('mine', on)
    w.gh.search = [node(), node({ url: 'https://github.com/acme/web/pull/13', number: 13, headRefOid: 'ccc' })]
    await w.a.poll()
    w.a.deliver()
    w.pane.id = null // it died at once
    w.a.deliver()
    w.a.deliver()
    expect(w.started).toHaveLength(1)
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
    // A line that was never taken: after a while the next one goes.
    expect(paneReady({ value: 'idle', at: now - SEND_LOST_MS - 5_000 }, now - SEND_LOST_MS - 1, 0, '', now)).toBe(true)
  })
})
