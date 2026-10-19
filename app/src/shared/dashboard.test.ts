import { describe, expect, it } from 'vitest'
import {
  attentionItems,
  deliveryView,
  fingerprintOf,
  healthView,
  nowView,
  pruneDismissed,
  relTime,
  weekStart,
  usageView,
  type AttentionInput,
  type DeliveryInput,
  type HealthInput,
  type NowInput,
  type UsageInput,
} from './dashboard'
import { EMPTY_INBOX, type InboxEntry, type InboxItem, type InboxKind } from './inbox'
import type { TeamPr } from './teamPrs'
import type { Board, BoardCard, Pr, Session, TranscriptTail } from './types'
import type { SchedList, SchedRun, SchedView } from './sched'
import type { UpdateState } from './updates'
import type { WatchInfo } from './watches'
import type { PrWatchRow } from './watchPr'
import type { CostBook } from './costs'
import type { JanitorRow } from './ipc'
import type { ProcsAll } from './sessionProcs'

const NOW = new Date(2026, 9, 18, 15, 0).getTime() // Sunday 18 Oct 2026, 15:00 local
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function sess(key: string, state: Session['state'], extra: Partial<Session> = {}): Session {
  return { key, sessionId: `sid-${key}`, name: key, kind: 'background', bgId: key, pid: null, cwd: '/', state, rawState: state, startedAt: NOW - HOUR, issue: null, ...extra }
}

function tpr(n: number, extra: Partial<TeamPr> = {}): TeamPr {
  return {
    url: `https://github.com/acme/web/pull/${n}`, repo: 'web', number: n, title: `PR ${n}`, state: 'open', draft: false, author: 'me',
    createdAt: new Date(NOW - DAY).toISOString(), updatedAt: new Date(NOW - 2 * HOUR).toISOString(), closedAt: null, mergedAt: null,
    headRef: 'h', baseRef: 'main', additions: 0, deletions: 0, files: 0, reviewDecision: null, labels: [], requested: [], reviews: [],
    unresolvedThreads: 0, ci: null, issues: [], ...extra,
  }
}

function lpr(n: number, extra: Partial<Pr> = {}): Pr {
  return { url: `https://github.com/acme/api/pull/${n}`, repo: 'api', number: n, title: `Api ${n}`, unresolvedThreads: 0, ci: null, headRef: 'h', refsIssue: null, ...extra }
}

function entry(id: string, kind: InboxKind, priority: number, extra: Partial<InboxItem> = {}, firstSeen = NOW - HOUR): InboxEntry {
  return {
    item: { id, kind, priority, sessionKey: null, ticket: null, title: `Item ${id}`, body: `Body of ${id}\nsecond line`, actions: [{ type: 'open', label: 'Open' }, { type: 'reply', label: 'Reply', primary: true }], detail: { type: 'session' }, ...extra },
    state: 'open', firstSeen, lastSeen: NOW,
  }
}

function attn(extra: Partial<AttentionInput> = {}): AttentionInput {
  return { inbox: EMPTY_INBOX, sessions: [], prs: [], teamPrs: [], sessionPrs: {}, me: 'me', logins: [], watches: [], prWatches: [], sched: null, update: null, dismissed: [], max: 8, ...extra }
}

function run(id: string, scheduleId: string, status: SchedRun['status'], startedAt: number, extra: Partial<SchedRun> = {}): SchedRun {
  return { id, scheduleId, scheduleName: `job-${scheduleId}`, slot: null, trigger: 'schedule', status, startedAt, endedAt: startedAt + MIN, sessionName: 's', bgId: null, sessionId: null, seenWorking: true, seen: true, costUsd: 0, ...extra }
}

function schedView(id: string, extra: Partial<SchedView> = {}): SchedView {
  return {
    id, name: `job-${id}`, enabled: true, prompt: '', workflow: null, cwd: '/', account: null, model: null, mode: null, when: { kind: 'daily', time: '02:00' }, tz: 'UTC',
    skipIfRunning: true, maxCostUsd: null, notify: { finish: false, failure: true }, missed: 'once', createdAt: 0, updatedAt: 0, lastSlot: 0,
    cron: '0 2 * * *', whenText: 'Every day at 02:00', nextAt: null, running: false, lastRun: null, ...extra,
  }
}

function sched(runs: SchedRun[], schedules: SchedView[] = []): SchedList {
  return { schedules, runs, tz: 'UTC' }
}

function watch(id: string, extra: Partial<WatchInfo> = {}): WatchInfo {
  return { id, sessionId: 'sid-a', description: `watch ${id}`, command: 'tail -f x', startedAt: NOW - HOUR, events: 0, lastEventAt: null, queued: 0, ...extra }
}

function prw(n: number, extra: Partial<PrWatchRow> = {}): PrWatchRow {
  return { url: `https://github.com/acme/web/pull/${n}`, repo: 'acme/web', number: n, title: `PR ${n}`, manual: true, tabId: null, tabName: null, account: null, target: { kind: 'none' } as unknown as PrWatchRow['target'], lastEvent: null, startedAt: NOW - HOUR, error: null, ...extra }
}

function upd(extra: Partial<UpdateState> = {}): UpdateState {
  return { current: '0.9.0', platform: 'darwin', arch: 'arm64', enabled: true, phase: 'up-to-date', mandatory: false, ...extra }
}

const offer = { version: '0.9.1', channel: 'stable' as const, notes: '', name: 'x.zip', url: 'https://x', sha512: '', size: 1, signature: '', publishedAt: 0, mandatory: false }

describe('attentionItems', () => {
  it('puts inbox items in tiers at the 80 and 30 boundaries', () => {
    const inbox = { open: [entry('a', 'blocked', 80), entry('b', 'loop', 79), entry('c', 'context', 30), entry('d', 'waiting', 29)], snoozed: [], history: [] }
    const l = attentionItems(attn({ inbox }), NOW)
    expect(l.items.map((i) => [i.id, i.tier])).toEqual([['a', 'now'], ['b', 'soon'], ['c', 'soon'], ['d', 'info']])
    expect(l.items[0]).toMatchObject({ title: 'Item a', why: 'Body of a', inboxId: 'a', rank: 80, at: NOW - HOUR })
    expect(l.now).toBe(1)
  })

  it('gives an inbox item its primary action and Open for its session', () => {
    const inbox = { open: [entry('a', 'input', 100, { sessionKey: 'k1' })], snoozed: [], history: [] }
    const [i] = attentionItems(attn({ inbox }), NOW).items
    expect(i.actions).toEqual([
      { type: 'inbox', action: 'reply', label: 'Reply', primary: true },
      { type: 'open', label: 'Open', target: { session: 'k1' } },
    ])
    expect(i.target).toEqual({ session: 'k1' })
  })

  it('leaves snoozed items out', () => {
    const inbox = { open: [], snoozed: [{ ...entry('s', 'input', 100), state: 'snoozed' as const, snoozedUntil: NOW + HOUR }], history: [] }
    expect(attentionItems(attn({ inbox }), NOW).total).toBe(0)
  })

  it('finds a failing CI on my PR', () => {
    const l = attentionItems(attn({ teamPrs: [tpr(218, { ci: 'failure' })] }), NOW)
    expect(l.items).toHaveLength(1)
    expect(l.items[0]).toMatchObject({ id: 'pr:https://github.com/acme/web/pull/218:ci', tier: 'now', rank: 70, title: 'CI failed on your PR acme/web#218', why: 'PR 218', target: { pr: 'https://github.com/acme/web/pull/218' } })
    expect(l.items[0].actions[0]).toEqual({ type: 'open', label: 'Open PR', primary: true, target: { pr: 'https://github.com/acme/web/pull/218' } })
  })

  it('finds changes requested, unresolved threads and ready to merge', () => {
    const l = attentionItems(attn({ teamPrs: [tpr(1, { reviewDecision: 'CHANGES_REQUESTED' }), tpr(2, { unresolvedThreads: 3 }), tpr(3, { unresolvedThreads: 1 }), tpr(4, { reviewDecision: 'APPROVED', ci: 'success' }), tpr(5, { reviewDecision: 'APPROVED' })] }), NOW)
    const by = Object.fromEntries(l.items.map((i) => [i.title, [i.tier, i.rank]]))
    expect(by).toEqual({
      'Changes requested on acme/web#1': ['soon', 55],
      '3 unresolved threads on acme/web#2': ['soon', 50],
      '1 unresolved thread on acme/web#3': ['soon', 50],
      'acme/web#4 is ready to merge': ['ready', 20],
      'acme/web#5 is ready to merge': ['ready', 20],
    })
    expect(l.items.find((i) => i.title.includes('#4'))!.actions[0]).toMatchObject({ type: 'merge', label: 'Merge…' })
  })

  it('ignores drafts, closed PRs and other people\'s PRs', () => {
    const l = attentionItems(attn({ teamPrs: [tpr(1, { ci: 'failure', draft: true }), tpr(2, { ci: 'failure', state: 'merged' }), tpr(3, { ci: 'failure', author: 'bob' })] }), NOW)
    expect(l.total).toBe(0)
  })

  it('counts a PR as mine through a second account\'s login, ignoring case', () => {
    const l = attentionItems(attn({ me: 'me', logins: ['me', 'Me-Work'], teamPrs: [tpr(9, { ci: 'failure', author: 'me-work' })] }), NOW)
    expect(l.total).toBe(1)
  })

  it('gives a PR one item, its strongest reason, with the others in why', () => {
    const l = attentionItems(attn({ teamPrs: [tpr(7, { ci: 'failure', reviewDecision: 'CHANGES_REQUESTED', unresolvedThreads: 2 })] }), NOW)
    expect(l.items).toHaveLength(1)
    expect(l.items[0].title).toBe('CI failed on your PR acme/web#7')
    expect(l.items[0].why).toBe('Changes requested · 2 unresolved threads · PR 7')
  })

  it('names the session that owns the PR and offers to open it', () => {
    const s = sess('k1', 'idle', { name: 'web-billing-221' })
    const l = attentionItems(attn({ sessions: [s], sessionPrs: { 'sid-k1': ['https://github.com/acme/web/pull/7'] }, teamPrs: [tpr(7, { ci: 'failure' })] }), NOW)
    expect(l.items[0].why).toBe('PR 7 · session web-billing-221')
    expect(l.items[0].actions[1]).toEqual({ type: 'open', label: 'Open session', target: { session: 'k1' } })
  })

  const offerEntry = (id: string, kind: 'ci' | 'review', n: number, sessionKey: string | null = null) => {
    const p = lpr(n, { url: `https://github.com/acme/web/pull/${n}` })
    return entry(id, kind, kind === 'ci' ? 70 : 50, { sessionKey, detail: { type: 'offer', offer: { id, pr: p, kind, owner: null, proposal: null, message: '' } } })
  }

  it('puts an inbox ci item in Now, as the derived CI row', () => {
    const inbox = { open: [offerEntry('offer:x', 'ci', 7)], snoozed: [], history: [] }
    const [i] = attentionItems(attn({ inbox }), NOW).items
    expect(i).toMatchObject({ id: 'offer:x', tier: 'now', rank: 70 })
  })

  it('lets a ci offer hide its own PR\'s CI failure only, not the session\'s other PRs', () => {
    const s = sess('k1', 'idle')
    const inbox = { open: [offerEntry('offer:x', 'ci', 7, 'k1')], snoozed: [], history: [] }
    const urls = ['https://github.com/acme/web/pull/7', 'https://github.com/acme/web/pull/8']
    const l = attentionItems(attn({ inbox, sessions: [s], sessionPrs: { 'sid-k1': urls }, teamPrs: [tpr(7, { ci: 'failure' }), tpr(8, { ci: 'failure' })] }), NOW)
    expect(l.items.map((i) => i.id).sort()).toEqual(['offer:x', 'pr:https://github.com/acme/web/pull/8:ci'])
  })

  it('lets a ci offer hide only CI: changes requested still shows', () => {
    const inbox = { open: [offerEntry('offer:x', 'ci', 7)], snoozed: [], history: [] }
    const l = attentionItems(attn({ inbox, teamPrs: [tpr(7, { ci: 'failure', reviewDecision: 'CHANGES_REQUESTED' })] }), NOW)
    expect(l.items.map((i) => i.title)).toEqual(['Item offer:x', 'Changes requested on acme/web#7'])
  })

  it('lets a review offer hide changes requested and threads, not CI', () => {
    const inbox = { open: [offerEntry('offer:r', 'review', 7)], snoozed: [], history: [] }
    const l = attentionItems(attn({ inbox, teamPrs: [tpr(7, { reviewDecision: 'CHANGES_REQUESTED', unresolvedThreads: 2 }), tpr(9, { ci: 'failure', reviewDecision: 'CHANGES_REQUESTED' })] }), NOW)
    expect(l.items.map((i) => i.id)).toEqual(['pr:https://github.com/acme/web/pull/9:ci', 'offer:r'])
    const both = attentionItems(attn({ inbox, teamPrs: [tpr(7, { ci: 'failure', unresolvedThreads: 2 })] }), NOW)
    expect(both.items.map((i) => i.id)).toEqual(['pr:https://github.com/acme/web/pull/7:ci', 'offer:r'])
    expect(both.items[0].why).toBe('PR 7')
  })

  it('finds review requests from prs and from teamPrs, once per PR', () => {
    const l = attentionItems(attn({
      logins: ['me', 'me-work'],
      prs: [lpr(1, { reviewRequested: true }), lpr(2)],
      teamPrs: [tpr(5, { author: 'bob', requested: ['ME-WORK'] }), tpr(6, { author: 'bob', requested: ['team:core'] }), { ...tpr(1, { author: 'bob', requested: ['me'] }), url: 'https://github.com/acme/api/pull/1' }],
    }), NOW)
    expect(l.items.map((i) => [i.title, i.tier, i.rank])).toEqual([
      ['Your review is requested on acme/api#1', 'soon', 45],
      ['Your review is requested on acme/web#5', 'soon', 45],
    ])
    expect(l.items[1].why).toBe('PR 5 · by bob')
    expect(l.items[1].actions).toEqual([{ type: 'review', label: 'Review', primary: true }])
  })

  it('keeps a review request dismissed when the team\'s read drops the PR for a moment', () => {
    const url = 'https://github.com/acme/api/pull/1'
    const at = new Date(NOW - 2 * HOUR).toISOString()
    const fromMaster = lpr(1, { reviewRequested: true, updatedAt: at })
    const fromTeam = { ...tpr(1, { author: 'bob', requested: ['me'], updatedAt: at, ci: 'failure' }), url }
    const both = attentionItems(attn({ prs: [fromMaster], teamPrs: [fromTeam] }), NOW)
    const fp = both.items[0].fingerprint
    const dismissed = [{ id: `pr:${url}:review`, fingerprint: fp }]
    expect(attentionItems(attn({ prs: [fromMaster], teamPrs: [fromTeam], dismissed }), NOW).total).toBe(0)
    expect(attentionItems(attn({ prs: [fromMaster], teamPrs: [], dismissed }), NOW).total).toBe(0)
    expect(attentionItems(attn({ prs: [], teamPrs: [fromTeam], dismissed }), NOW).total).toBe(0)
    // Updated since: news again.
    expect(attentionItems(attn({ prs: [{ ...fromMaster, updatedAt: new Date(NOW).toISOString() }], dismissed }), NOW).total).toBe(1)
  })

  it('leaves out a review request on a draft or closed PR, whichever source lists it', () => {
    const url = 'https://github.com/acme/api/pull/1'
    const fromMaster = lpr(1, { reviewRequested: true })
    for (const t of [{ draft: true }, { state: 'closed' as const }]) {
      const team = { ...tpr(1, { author: 'bob', requested: ['me'], ...t }), url }
      expect(attentionItems(attn({ prs: [fromMaster], teamPrs: [team] }), NOW).total).toBe(0)
      expect(attentionItems(attn({ teamPrs: [team] }), NOW).total).toBe(0)
    }
  })

  it('finds a schedule whose last run failed in the last day', () => {
    const l = attentionItems(attn({ sched: sched([run('r1', 's1', 'failed', NOW - 2 * HOUR, { reason: 'The session never started' })], [schedView('s1')]) }), NOW)
    expect(l.items[0]).toMatchObject({ id: 'run:r1', tier: 'soon', rank: 42, title: 'Schedule "job-s1" failed', why: 'The session never started', target: { schedules: true }, scheduleId: 's1', fingerprint: 'r1' })
    expect(l.items[0].actions.map((a) => a.type)).toEqual(['retry', 'open'])
  })

  it('gives nothing for a failed run with a later run, one older than a day, or one of a deleted schedule', () => {
    expect(attentionItems(attn({ sched: sched([run('r1', 's1', 'failed', NOW - 3 * HOUR), run('r2', 's1', 'done', NOW - HOUR)], [schedView('s1')]) }), NOW).total).toBe(0)
    expect(attentionItems(attn({ sched: sched([run('r1', 's1', 'failed', NOW - 25 * HOUR)], [schedView('s1')]) }), NOW).total).toBe(0)
    expect(attentionItems(attn({ sched: sched([run('r1', 's1', 'failed', NOW - HOUR)], [schedView('other')]) }), NOW).total).toBe(0)
  })

  it('offers no Retry for a disabled schedule', () => {
    const l = attentionItems(attn({ sched: sched([run('r1', 's1', 'failed', NOW - HOUR)], [schedView('s1', { enabled: false })]) }), NOW)
    expect(l.items[0].actions).toEqual([{ type: 'open', label: 'Open', primary: true }])
  })

  it('finds a monitor error and a PR watch error', () => {
    const l = attentionItems(attn({ sessions: [sess('a', 'idle')], watches: [watch('w1', { error: 'gh: not found', errorAt: NOW - MIN })], prWatches: [prw(3, { error: 'HTTP 404' }), prw(4)] }), NOW)
    expect(l.items.map((i) => [i.id, i.title, i.why])).toEqual([
      ['watch:pr:https://github.com/acme/web/pull/3', 'PR watch "acme/web#3" cannot read its source', 'HTTP 404'],
      ['watch:w1', 'Monitor "watch w1" cannot read its source', 'gh: not found'],
    ])
    expect(l.items[1].target).toEqual({ session: 'a' })
    expect(l.items[0].target).toEqual({ view: 'prs' })
  })

  it('reads the real watch list: monitors, PR watches (pr:) and Automate Review tabs (review:) once each', () => {
    const url = 'https://github.com/acme/web/pull/3'
    const watches = [
      watch('w1', { error: 'gh: not found', errorAt: NOW - MIN }),
      watch(`pr:${url}`, { error: 'HTTP 404', errorAt: NOW - 10 * MIN, description: 'PR watch acme/web#3' }),
      watch('review:tab1', { sessionId: '', error: 'cannot read', errorAt: NOW - MIN, description: 'Automate Review' }),
    ]
    const prWatches = [prw(3, { error: 'HTTP 404', target: { session: { key: 'a', name: 'a' } } })]
    const l = attentionItems(attn({ sessions: [sess('a', 'idle')], watches, prWatches }), NOW)
    expect(l.items.map((i) => i.id)).toEqual([`watch:pr:${url}`, 'watch:w1'])
    expect(l.items[0]).toMatchObject({ at: NOW - 10 * MIN, target: { session: 'a' }, fingerprint: `HTTP 404|${NOW - 10 * MIN}` })
    const v = nowView(nowIn({ sessions: [sess('a', 'idle')], watches, prWatches }), NOW)
    expect(v.watching.map((w) => w.id)).toEqual([`prwatch:${url}`, 'watch:w1'])
  })

  it('offers an update only when it is ready with an offer', () => {
    expect(attentionItems(attn({ update: upd({ phase: 'available', offer }) }), NOW).total).toBe(0)
    expect(attentionItems(attn({ update: upd({ phase: 'ready' }) }), NOW).total).toBe(0)
    const l = attentionItems(attn({ update: upd({ phase: 'ready', offer }) }), NOW)
    expect(l.items[0]).toMatchObject({ id: 'update:0.9.1', tier: 'info', rank: 15, title: 'MasterDeck 0.9.1 is ready to install', fingerprint: '0.9.1' })
    expect(l.items[0].actions[0]).toMatchObject({ type: 'update', label: 'Restart' })
  })

  it('sorts by tier, then rank, then oldest first, then id', () => {
    const inbox = { open: [entry('z', 'input', 100, {}, NOW - HOUR), entry('y', 'input', 100, {}, NOW - HOUR), entry('x', 'input', 100, {}, NOW - 2 * HOUR), entry('w', 'error', 95), entry('v', 'idle', 20)], snoozed: [], history: [] }
    const l = attentionItems(attn({ inbox, teamPrs: [tpr(1, { reviewDecision: 'APPROVED' })] }), NOW)
    expect(l.items.map((i) => i.id)).toEqual(['x', 'y', 'z', 'w', 'pr:https://github.com/acme/web/pull/1:ready', 'v'])
  })

  it('hides a dismissed derived item while its fingerprint matches', () => {
    const p = tpr(7, { ci: 'failure' })
    const fp = fingerprintOf({ pr: p })
    expect(fp).toBe(`failure|null|0|${p.updatedAt}`)
    const id = 'pr:https://github.com/acme/web/pull/7:ci'
    expect(attentionItems(attn({ teamPrs: [p], dismissed: [{ id, fingerprint: fp }] }), NOW).total).toBe(0)
    expect(attentionItems(attn({ teamPrs: [{ ...p, unresolvedThreads: 1 }], dismissed: [{ id, fingerprint: fp }] }), NOW).total).toBe(1)
  })

  it('makes fingerprints for runs, watches and updates', () => {
    expect(fingerprintOf({ run: run('r9', 's', 'failed', 0) })).toBe('r9')
    expect(fingerprintOf({ watch: { error: 'x', errorAt: 5 } })).toBe('x|5')
    expect(fingerprintOf({ watch: { error: 'x' } })).toBe('x|')
    expect(fingerprintOf({ update: '1.0.0' })).toBe('1.0.0')
  })

  it('caps at max and counts the rest; now counts only the now tier', () => {
    const inbox = { open: [entry('a', 'input', 100), entry('b', 'input', 100), entry('c', 'idle', 20), entry('d', 'idle', 20)], snoozed: [], history: [] }
    const l = attentionItems(attn({ inbox, max: 3 }), NOW)
    expect(l.items).toHaveLength(3)
    expect(l).toMatchObject({ total: 4, more: 1, now: 2 })
  })

  it('lists every derived subject present, for pruning', () => {
    const p = tpr(7, { ci: 'failure' })
    const id = 'pr:https://github.com/acme/web/pull/7:ci'
    const l = attentionItems(attn({ teamPrs: [p], dismissed: [{ id, fingerprint: fingerprintOf({ pr: p }) }] }), NOW)
    expect(l.subjects).toEqual([id])
  })
})

describe('pruneDismissed', () => {
  it('keeps dismissals of subjects still present, at most 200, newest kept', () => {
    expect(pruneDismissed([{ id: 'a', fingerprint: '1' }, { id: 'b', fingerprint: '2' }], ['b', 'c'])).toEqual([{ id: 'b', fingerprint: '2' }])
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, fingerprint: '' }))
    const kept = pruneDismissed(many, many.map((d) => d.id))
    expect(kept).toHaveLength(200)
    expect(kept[0].id).toBe('x50')
  })

  it('keeps the dismissals of a source still loading', () => {
    const d = [
      { id: 'run:1', fingerprint: '1' },
      { id: 'pr:https://github.com/acme/web/pull/1:ci', fingerprint: 'x' },
      { id: 'watch:m1', fingerprint: 'e|1' },
      { id: 'update:0.9.1', fingerprint: '0.9.1' },
    ]
    // Nothing loaded: only the monitor, which comes with every state, is pruned.
    expect(pruneDismissed(d, [], { sched: false, prs: false, update: false }).map((x) => x.id)).toEqual(['run:1', 'pr:https://github.com/acme/web/pull/1:ci', 'update:0.9.1'])
    // Schedules read, PRs not: the run goes, the PR stays.
    expect(pruneDismissed(d, [], { sched: true, prs: false, update: true }).map((x) => x.id)).toEqual(['pr:https://github.com/acme/web/pull/1:ci'])
    // Everything read: only what is present stays.
    expect(pruneDismissed(d, ['watch:m1'], { sched: true, prs: true, update: true }).map((x) => x.id)).toEqual(['watch:m1'])
  })
})

function nowIn(extra: Partial<NowInput> = {}): NowInput {
  return { sessions: [], tails: {}, issues: [], board: null, multi: false, procs: null, watches: [], prWatches: [], autoReview: null, sched: null, ...extra }
}

function tail(lastTool: string | null, lastToolAt: number | null): TranscriptTail {
  return { model: null, contextTokens: null, lastTool, lastToolAt, lastActivityAt: null, cwd: null, gitBranch: null, permissionMode: null }
}

describe('nowView', () => {
  it('is empty with nothing going on', () => {
    const v = nowView(nowIn(), NOW)
    expect(v).toEqual({ sessions: [], total: 0, more: 0, procs: null, watching: [], nextRuns: [] })
  })

  it('lists working, background, waiting and needs-you sessions in that order', () => {
    const sessions = [
      sess('n', 'needs-input'),
      sess('w2', 'working', { startedAt: NOW - 30 * MIN }),
      sess('b', 'idle', { busyWith: 'npm test' }),
      sess('i', 'idle'),
      sess('wt', 'idle', { waitingOn: 'a Monitor' }),
      sess('d', 'done'),
      sess('w1', 'working', { startedAt: NOW - 2 * HOUR, issue: 42, account: 'me-work' }),
    ]
    const v = nowView(nowIn({ sessions, multi: true, tails: { 'sid-w1': tail('Bash', NOW - MIN) }, issues: [{ number: 42, title: 'Fix token refresh', url: '', status: null, currentSprint: true, assignedToMe: true }] }), NOW)
    expect(v.sessions.map((r) => [r.key, r.chip, r.chipLabel])).toEqual([
      ['w1', 'working', 'Working'],
      ['w2', 'working', 'Working'],
      ['b', 'background', 'Background command'],
      ['wt', 'waiting', 'Waiting on a Monitor'],
      ['n', 'needs-you', 'Needs you'],
    ])
    expect(v.sessions[0]).toMatchObject({ name: 'w1', account: 'me-work', since: NOW - 2 * HOUR, ticket: '#42 Fix token refresh', lastTool: 'Bash', lastToolAt: NOW - MIN })
    expect(v.sessions[1]).toMatchObject({ account: null, ticket: null, lastTool: null })
  })

  it('shows no account with one account, and a board card title before an issue\'s', () => {
    const card: BoardCard = { number: 5, repo: 'acme/web', title: 'From the board', url: '', status: 'In Dev', prs: [], assignees: [], labels: [], milestone: null, type: null }
    const board: Board = { takenAt: null, sprint: null, columns: ['In Dev'], cards: [card] }
    const v = nowView(nowIn({ sessions: [sess('a', 'working', { account: 'x', issue: 5, issueRepo: 'acme/web' })], board }), NOW)
    expect(v.sessions[0]).toMatchObject({ account: null, ticket: 'web#5 From the board' })
  })

  it('shows at most 6 sessions and counts the rest', () => {
    const v = nowView(nowIn({ sessions: Array.from({ length: 8 }, (_, i) => sess(`s${i}`, 'working')) }), NOW)
    expect(v.sessions).toHaveLength(6)
    expect(v).toMatchObject({ total: 8, more: 2 })
  })

  it('lists the running processes with ports of listed sessions', () => {
    const p = (pid: number, command: string, ports: number[], state: 'running' | 'exited' = 'running') => ({ pid, command, state, ports: ports.map((port) => ({ host: '127.0.0.1', port })) })
    const procs = { at: NOW - 3 * MIN, sessions: { a: [p(1, 'npm run dev', [5173]), p(2, 'npm test', []), p(3, 'old', [9000], 'exited')], gone: [p(4, 'vite', [5174])], d: [p(5, 'vite', [5175])] }, strays: [] }
    const v = nowView(nowIn({ sessions: [sess('a', 'working', { name: 'web' }), sess('d', 'done')], procs: procs as unknown as ProcsAll }), NOW)
    expect(v.procs).toEqual({ at: NOW - 3 * MIN, error: null, rows: [{ key: 'a', session: 'web', pid: 1, command: 'npm run dev', ports: [5173] }] })
    expect(nowView(nowIn({ procs: { at: NOW, sessions: {}, strays: [] } }), NOW).procs).toEqual({ at: NOW, error: null, rows: [] })
    expect(nowView(nowIn({ procs: { at: NOW, sessions: {}, strays: [], error: 'ps failed (exit 1)' } }), NOW).procs).toEqual({ at: NOW, error: 'Processes could not be read: ps failed (exit 1)', rows: [] })
  })

  it('lists what it is watching', () => {
    const autoReview = { tabs: {}, prs: [
      { url: 'u1', repo: 'acme/web', number: 8, title: 't', author: 'bob', tabId: 't', status: 'reviewing', at: NOW - MIN, reviewUrl: null, comments: 0, note: null },
      { url: 'u2', repo: 'acme/web', number: 9, title: 't', author: 'bob', tabId: 't', status: 'ready', at: NOW - MIN, reviewUrl: null, comments: 0, note: null },
    ] } as unknown as NowInput['autoReview']
    const v = nowView(nowIn({ sessions: [sess('a', 'idle')], prWatches: [prw(3, { lastEvent: { at: NOW - 5 * MIN, text: 'x' } })], watches: [watch('w1', { lastEventAt: NOW - 2 * MIN })], autoReview }), NOW)
    expect(v.watching).toEqual([
      { id: 'prwatch:https://github.com/acme/web/pull/3', label: 'PR watch · acme/web#3', at: NOW - 5 * MIN, target: { pr: 'https://github.com/acme/web/pull/3' } },
      { id: 'watch:w1', label: 'watch w1', at: NOW - 2 * MIN, target: { session: 'a' } },
      { id: 'review:u1', label: 'Reviewing acme/web#8', at: NOW - MIN, target: { pr: 'u1' } },
    ])
  })

  it('lists the next three enabled runs, soonest first', () => {
    const schedules = [schedView('a', { nextAt: NOW + 3 * HOUR }), schedView('b', { nextAt: NOW + HOUR }), schedView('c', { nextAt: NOW + 2 * HOUR, enabled: false }), schedView('d', { nextAt: null }), schedView('e', { nextAt: NOW + 5 * HOUR }), schedView('f', { nextAt: NOW + 9 * HOUR })]
    const v = nowView(nowIn({ sched: sched([], schedules) }), NOW)
    expect(v.nextRuns.map((r) => [r.id, r.at])).toEqual([['b', NOW + HOUR], ['a', NOW + 3 * HOUR], ['e', NOW + 5 * HOUR]])
    expect(v.nextRuns[0]).toMatchObject({ name: 'job-b', when: 'today 16:00' })
  })
})

function card(n: number, status: string | null, extra: Partial<BoardCard> = {}): BoardCard {
  return { number: n, title: `Card ${n}`, url: '', status, prs: [], assignees: [], labels: [], milestone: null, type: null, project: 'acme/1', ...extra }
}

function delIn(extra: Partial<DeliveryInput> = {}): DeliveryInput {
  return { board: null, boardHistory: {}, sprints: [], teamPrs: [], prs: [], me: 'me', logins: [], ...extra }
}

describe('deliveryView', () => {
  it('says there is no board', () => {
    const v = deliveryView(delIn(), NOW)
    expect(v.sprint).toEqual({ kind: 'none', text: 'No board yet. Pick one in Setup, or create a GitHub board.' })
  })

  it('counts the sprint\'s cards per board column, in order, with the board\'s names', () => {
    const board: Board = { takenAt: null, sprint: 'Sprint 9', columns: ['Todo', 'In Dev', 'Done'], cards: [card(1, 'Done'), card(2, 'Todo'), card(3, 'Done'), card(4, null), card(5, 'Elsewhere')] }
    const sprints = [{ id: 's9', title: 'Sprint 9', startDate: '2026-10-15', duration: 7, completed: false }]
    const boardHistory = { 'Sprint 9': [{ date: '2026-10-15', total: 5, done: 0 }, { date: '2026-10-18', total: 5, done: 2 }] }
    const v = deliveryView(delIn({ board, sprints, boardHistory }), NOW)
    if (v.sprint.kind !== 'board') throw new Error('expected a board')
    expect(v.sprint.title).toBe('Sprint 9')
    expect(v.sprint.total).toBe(5)
    expect(v.sprint.columns).toEqual([{ name: 'Todo', count: 1 }, { name: 'In Dev', count: 0 }, { name: 'Done', count: 2 }, { name: 'No status', count: 2 }])
    expect(v.sprint.burndown).not.toBeNull()
    expect(v.sprint.burndown!.points).toHaveLength(7)
    expect(v.sprint.burndown!.points[3]).toEqual({ date: '2026-10-18', remaining: 3, ideal: 5 - (5 * 3) / 6 })
    expect(v.sprint.burndown).toMatchObject({ left: 3, planned: 3 })
  })

  it('shows the counts without a burndown on a sprintless board', () => {
    const board: Board = { takenAt: null, sprint: null, columns: ['Todo'], cards: [card(1, 'Todo')] }
    const v = deliveryView(delIn({ board }), NOW)
    expect(v.sprint).toMatchObject({ kind: 'board', title: null, burndown: null, columns: [{ name: 'Todo', count: 1 }] })
  })

  it('says a derived board has no sprint, with its counts', () => {
    const board: Board = { takenAt: null, sprint: null, columns: ['Todo', 'Done'], cards: [card(1, 'Todo', { derived: true, project: null })], derived: [{ account: null, repos: ['acme/web'], total: 1, shown: 1, skipped: [], missing: [] }] }
    const v = deliveryView(delIn({ board }), NOW)
    expect(v.sprint).toMatchObject({ kind: 'derived', text: 'No sprint: this account has no GitHub board', columns: [{ name: 'Todo', count: 1 }, { name: 'In Dev', count: 0 }, { name: 'PR Raised', count: 0 }, { name: 'Done', count: 0 }] })
  })

  it('leaves derived cards out of a board with a sprint', () => {
    const board: Board = { takenAt: null, sprint: null, columns: ['Ready', 'Done'], cards: [card(1, 'Ready'), card(2, 'Todo', { derived: true, project: null }), card(3, 'Done', { derived: true, project: null })], derived: [{ account: 'x', repos: ['acme/web'], total: 2, shown: 2, skipped: [], missing: [] }] }
    const v = deliveryView(delIn({ board }), NOW)
    expect(v.sprint).toMatchObject({ kind: 'board', total: 1, columns: [{ name: 'Ready', count: 1 }, { name: 'Done', count: 0 }] })
  })

  it('counts my PRs: KPIs and stages', () => {
    const teamPrs = [
      tpr(1, { draft: true }),
      tpr(2),
      tpr(3, { reviewDecision: 'CHANGES_REQUESTED' }),
      tpr(4, { reviewDecision: 'APPROVED', ci: 'success' }),
      tpr(5, { reviewDecision: 'APPROVED', unresolvedThreads: 1 }),
      tpr(6, { state: 'merged', mergedAt: new Date(NOW - 2 * DAY).toISOString() }),
      tpr(7, { state: 'merged', mergedAt: new Date(NOW - 8 * DAY).toISOString() }),
      tpr(8, { author: 'bob', requested: ['me'] }),
    ]
    const v = deliveryView(delIn({ teamPrs, prs: [lpr(1, { reviewRequested: true })] }), NOW)
    expect(v.prs.kpis).toEqual([
      { id: 'mine', label: 'Mine open', value: 5, tab: 'mine' },
      { id: 'review', label: 'Waiting on you', value: 2, tab: 'review' },
      { id: 'merged', label: 'Merged in 7 days', value: 1, tab: 'merged' },
      { id: 'ready', label: 'Ready to merge', value: 1, tab: 'mine' },
    ])
    expect(v.prs.stages).toEqual([
      { id: 'draft', label: 'Draft', count: 1 },
      { id: 'review', label: 'In review', count: 1 },
      { id: 'changes', label: 'Changes requested', count: 1 },
      { id: 'approved', label: 'Approved', count: 2 },
    ])
  })
})

function book(): CostBook {
  // Sunday 18 Oct: today. Monday 12 Oct: the week's start.
  return {
    s1: { name: 'web', key: 'k1', issue: 42, days: { '2026-10-18T10': 5, '2026-10-18T12': 8 }, account: 'me' } as CostBook[string],
    s2: { name: 'api', key: 'k2', issue: null, days: { '2026-10-13T09': 4 }, account: 'me-work' } as CostBook[string],
    s3: { name: 'old', key: 'k3', issue: null, days: { '2026-10-16T09': 1 } },
    s4: { name: 'prev', key: 'k4', issue: null, days: { '2026-10-10T09': 2 } },
  }
}

function useIn(extra: Partial<UsageInput> = {}): UsageInput {
  return { costBook: {}, sessions: [], hookInfo: {}, ghCache: null, budgetPerTicketUsd: 20, logins: [], tokensByDay: null, ...extra }
}

describe('usageView', () => {
  it('sums today and this week from the cost book', () => {
    const v = usageView(useIn({ costBook: book() }), NOW)
    expect(v.today.cost).toBeCloseTo(8)
    expect(v.week.cost).toBeCloseTo(13)
    expect(v.today.tokens).toBeNull()
  })

  it('has no account table with one account', () => {
    expect(usageView(useIn({ costBook: book(), logins: ['me'] }), NOW).accounts).toEqual([])
  })

  it('lists per account with Unknown account last', () => {
    const v = usageView(useIn({ costBook: book(), logins: ['me', 'me-work', 'idle-acct'] }), NOW)
    expect(v.accounts.map((a) => [a.label, Math.round(a.today), Math.round(a.week)])).toEqual([
      ['me', 8, 8],
      ['me-work', 0, 4],
      ['idle-acct', 0, 0],
      ['Unknown account', 0, 1],
    ])
  })

  it('sums tokens when they are read', () => {
    const t = (n: number) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 })
    const v = usageView(useIn({ costBook: book(), logins: ['me', 'me-work'], tokensByDay: { s1: { '2026-10-18T10': t(100) }, s2: { '2026-10-13T09': t(50) } } }), NOW)
    expect(v.today.tokens).toBe(100)
    expect(v.week.tokens).toBe(150)
    expect(v.accounts.find((a) => a.label === 'me-work')!.tokens).toBe(50)
  })

  it('gives a 7-day series ending today', () => {
    const v = usageView(useIn({ costBook: book() }), NOW)
    expect(v.trend.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'])
    expect(v.trend.map((d) => Math.round(d.cost))).toEqual([0, 4, 0, 0, 1, 0, 8])
  })

  it('lists the top 3 sessions of the week', () => {
    const v = usageView(useIn({ costBook: book(), sessions: [sess('k1', 'idle')] }), NOW)
    expect(v.top.map((t) => [t.name, Math.round(t.cost), t.key])).toEqual([['web', 8, 'k1'], ['api', 4, null], ['old', 1, null]])
  })

  it('is empty with no costs', () => {
    const v = usageView(useIn(), NOW)
    expect(v).toMatchObject({ today: { cost: 0, tokens: null }, week: { cost: 0, tokens: null }, accounts: [], top: [], warnings: [] })
    expect(v.trend).toHaveLength(7)
  })

  it('warns of a session stopped on an API error in the last day', () => {
    const v = usageView(useIn({
      sessions: [sess('k1', 'idle', { name: 'web' }), sess('k2', 'idle')],
      hookInfo: {
        k1: { compacting: false, compactedAt: null, failure: { type: 'rate_limit', message: 'x', at: NOW - 40 * MIN } },
        k2: { compacting: false, compactedAt: null, failure: { type: 'overloaded', message: 'x', at: NOW - 25 * HOUR } },
      },
    }), NOW)
    expect(v.warnings).toEqual([{ id: 'failure:k1', text: 'web stopped on a rate limit 40 min ago', action: { type: 'session', key: 'k1', label: 'Open session' } }])
  })

  it('warns that GitHub is paused', () => {
    const pausedUntil = new Date(2026, 9, 18, 15, 20).getTime()
    const v = usageView(useIn({ ghCache: { pausedUntil, pauseReason: null, hit: 0, miss: 0, stale: 0, write: 0, blocked: 0 } }), NOW)
    expect(v.warnings).toEqual([{ id: 'gh-paused', text: 'GitHub is paused until 15:20 (rate limit)', action: null }])
    expect(usageView(useIn({ ghCache: { pausedUntil: NOW - MIN, pauseReason: null, hit: 0, miss: 0, stale: 0, write: 0, blocked: 0 } }), NOW).warnings).toEqual([])
  })

  it('warns of tickets over budget', () => {
    const costBook: CostBook = { a: { name: 'a', key: 'a', issue: 42, days: { '2026-10-18T10': 25 } }, b: { name: 'b', key: 'b', issue: 7, days: { '2026-10-18T10': 5 } } }
    const v = usageView(useIn({ costBook, budgetPerTicketUsd: 20 }), NOW)
    expect(v.warnings).toEqual([{ id: 'budget', text: '1 ticket is over the $20 budget: #42', action: { type: 'costs', label: 'Costs' } }])
    expect(usageView(useIn({ costBook, budgetPerTicketUsd: 0 }), NOW).warnings).toEqual([])
  })
})

function janRow(cls: JanitorRow['cls']): JanitorRow {
  return { cls, reason: '' } as JanitorRow
}

function healthIn(extra: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW, remoteEnabled: false, remote: undefined, browsers: [], ghAccounts: [{ login: 'me', primary: true, healthy: true }], ghCache: null, boardError: null, teamPrsError: null,
    sources: { agents: 'ok' }, errors: [], missingBinaries: [], hooks: { queue: true, foreignQueue: false, reviewGate: true, masterGuard: true }, statuslineInstalled: true,
    procs: { at: NOW, sessions: {}, strays: [] }, janitor: [], windows: false, update: null, ...extra,
  }
}

const row = (input: HealthInput, id: string) => healthView(input).rows.find((r) => r.id === id)

describe('healthView', () => {
  it('says All good when every row is ok, without the update row when there is no update state', () => {
    const v = healthView(healthIn())
    expect(v.allGood).toBe(true)
    expect(v.summary).toBe('All good')
    expect(v.rows.map((r) => r.id)).toEqual(['remote', 'github', 'claude', 'hooks', 'errors', 'strays', 'worktrees'])
    expect(v.rows.every((r) => r.status === 'ok')).toBe(true)
  })

  it('reads the remote line', () => {
    expect(row(healthIn(), 'remote')).toMatchObject({ status: 'ok', detail: 'Off' })
    expect(row(healthIn({ remoteEnabled: true, remote: { conn: 'connected', message: null, lastSyncAt: null, hasToken: true }, browsers: [{ id: 'b', name: 'b', approvedAt: 0, connected: true }] }), 'remote')).toMatchObject({ status: 'ok', detail: 'Connected · 1 browser' })
    expect(row(healthIn({ remoteEnabled: true, remote: { conn: 'connecting', message: null, lastSyncAt: null, hasToken: true } }), 'remote')).toMatchObject({ status: 'warn', detail: 'Connecting…' })
    expect(row(healthIn({ remoteEnabled: true, remote: { conn: 'error', message: 'token refused', lastSyncAt: null, hasToken: true } }), 'remote')).toMatchObject({ status: 'bad', detail: 'token refused' })
    expect(row(healthIn({ remoteEnabled: true, remote: { conn: 'off', message: null, lastSyncAt: null, hasToken: true } }), 'remote')).toMatchObject({ status: 'bad', detail: 'Off, though it is turned on in Settings' })
    expect(row(healthIn({ remoteEnabled: true, remote: { conn: 'off', message: 'Sign in first', lastSyncAt: null, hasToken: false } }), 'remote')).toMatchObject({ status: 'bad', detail: 'Sign in first' })
    expect(row(healthIn({ remoteEnabled: true }), 'remote')).toMatchObject({ status: 'unknown' })
    expect(healthView(healthIn({ remoteEnabled: true, remote: { conn: 'error', message: 'x', lastSyncAt: null, hasToken: true } })).summary).toBe('1 problem')
  })

  it('reads GitHub', () => {
    expect(row(healthIn({ ghAccounts: [{ login: 'me', primary: true, healthy: false, error: 'token refused' }] }), 'github')).toMatchObject({ status: 'bad', detail: 'me: token refused' })
    expect(row(healthIn({ ghCache: { pausedUntil: new Date(2026, 9, 18, 15, 20).getTime(), pauseReason: null, hit: 0, miss: 0, stale: 0, write: 0, blocked: 0 } }), 'github')).toMatchObject({ status: 'warn', detail: 'Paused until 15:20 (rate limit)' })
    expect(row(healthIn({ boardError: 'no project' }), 'github')).toMatchObject({ status: 'warn', detail: 'The board cannot be read: no project' })
    expect(row(healthIn({ teamPrsError: 'HTTP 502' }), 'github')).toMatchObject({ status: 'warn', detail: 'Pull requests cannot be read: HTTP 502' })
    expect(row(healthIn(), 'github')).toMatchObject({ status: 'ok', detail: '1 account connected' })
    expect(row(healthIn({ ghAccounts: undefined }), 'github')).toMatchObject({ status: 'unknown' })
  })

  it('reads Claude', () => {
    expect(row(healthIn({ sources: { agents: 'error' }, errors: ['claude agents: exit 1'] }), 'claude')).toMatchObject({ status: 'bad', detail: 'claude agents: exit 1' })
    expect(row(healthIn({ missingBinaries: ['claude', 'jq'] }), 'claude')).toMatchObject({ status: 'bad', detail: 'Not installed: claude, jq' })
    expect(row(healthIn({ sources: {} }), 'claude')).toMatchObject({ status: 'unknown' })
  })

  it('reads the hooks and the status line, with Fix', () => {
    const r = row(healthIn({ statuslineInstalled: false, hooks: { queue: true, foreignQueue: false, reviewGate: false, masterGuard: true } }), 'hooks')
    expect(r).toMatchObject({ status: 'warn', detail: 'Not installed: the self-review gate', action: { type: 'settings', section: 'hooks', label: 'Fix' } })
  })

  it('treats the status line as optional', () => {
    expect(row(healthIn({ statuslineInstalled: false }), 'hooks')).toMatchObject({ status: 'ok', detail: 'Installed · status line off' })
    expect(row(healthIn({}), 'hooks')).toMatchObject({ status: 'ok', detail: 'Installed' })
  })

  it('checks only the status line on Windows', () => {
    const none = { queue: false, foreignQueue: false, reviewGate: false, masterGuard: false }
    expect(row(healthIn({ windows: true, hooks: none }), 'hooks')).toMatchObject({ status: 'ok' })
    expect(row(healthIn({ windows: true, hooks: none, statuslineInstalled: false }), 'hooks')).toMatchObject({ status: 'ok', detail: 'Status line off' })
  })

  it('reads the errors', () => {
    expect(row(healthIn({ errors: ['one'] }), 'errors')).toMatchObject({ status: 'warn', detail: 'one' })
    expect(row(healthIn({ errors: ['one', 'two', 'three'] }), 'errors')).toMatchObject({ status: 'warn', detail: 'one, and 2 more' })
  })

  it('reads the strays', () => {
    expect(row(healthIn({ procs: null }), 'strays')).toMatchObject({ status: 'unknown', detail: 'Not checked' })
    expect(row(healthIn({ windows: true }), 'strays')).toMatchObject({ status: 'unknown', detail: 'Not available on Windows' })
    const strays = [{ pid: 9, command: '/usr/local/bin/vite --port 5174', cwd: '/w', ports: [{ host: '*', port: 5174 }], startedAt: 0, folderOf: '/w' }, { pid: 10, command: 'python -m http.server', cwd: '/w', ports: [{ host: '*', port: 8000 }], startedAt: 0, folderOf: '/w' }]
    const r = row(healthIn({ procs: { at: NOW, sessions: {}, strays } }), 'strays')
    expect(r).toMatchObject({ status: 'warn', detail: 'vite :5174 in w, not started by a session, and 1 more', action: { type: 'show-strays', label: 'Show' } })
    const solo = [{ ...strays[1], folderOf: '/home/u/acme/web' }]
    expect(row(healthIn({ procs: { at: NOW, sessions: {}, strays: solo } }), 'strays')).toMatchObject({ detail: 'python :8000 in web, not started by a session' })
    expect(row(healthIn({ procs: { at: NOW, sessions: {}, strays: [{ ...strays[1], folderOf: null }] } }), 'strays')).toMatchObject({ detail: 'python :8000, not started by a session' })
    expect(r!.strays).toHaveLength(2)
    expect(row(healthIn({ procs: { at: NOW, sessions: {}, strays: [], error: 'lsof failed' } }), 'strays')).toMatchObject({ status: 'warn', detail: 'Could not be read: lsof failed' })
  })

  it('reads the worktrees', () => {
    expect(row(healthIn({ janitor: null }), 'worktrees')).toMatchObject({ status: 'unknown', detail: 'Not checked', action: { type: 'check-worktrees', label: 'Check worktrees' } })
    expect(row(healthIn({ janitor: [janRow('SAFE'), janRow('SAFE'), janRow('DIRTY')] }), 'worktrees')).toMatchObject({ status: 'warn', detail: '2 can be removed', action: { type: 'view', view: 'janitor', label: 'Janitor' } })
    expect(row(healthIn({ janitor: [janRow('DIRTY')] }), 'worktrees')).toMatchObject({ status: 'ok', detail: 'Nothing to remove' })
  })

  it('reads MasterDeck\'s update', () => {
    expect(row(healthIn({ update: upd() }), 'masterdeck')).toMatchObject({ status: 'ok', detail: '0.9.0, up to date' })
    expect(row(healthIn({ update: upd({ phase: 'available', offer }) }), 'masterdeck')).toMatchObject({ status: 'warn', detail: '0.9.1 is available' })
    expect(row(healthIn({ update: upd({ phase: 'ready', offer }) }), 'masterdeck')).toMatchObject({ status: 'warn', detail: '0.9.1 is ready to install', action: { type: 'update', label: 'Restart to update' } })
    expect(row(healthIn({ update: upd({ phase: 'error', error: 'offline' }) }), 'masterdeck')).toMatchObject({ status: 'bad', detail: 'Update failed: offline' })
    expect(row(healthIn({ update: upd({ enabled: false }) }), 'masterdeck')).toMatchObject({ status: 'ok', detail: '0.9.0' })
    expect(row(healthIn({ update: upd({ phase: 'checking' }) }), 'masterdeck')).toMatchObject({ status: 'ok', detail: '0.9.0, checking for updates…' })
    expect(row(healthIn({ update: upd({ phase: 'installing', offer }) }), 'masterdeck')).toMatchObject({ status: 'warn', detail: 'Installing 0.9.1…' })
  })
})

describe('weekStart', () => {
  const at = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime()
  it('is Monday 00:00 on a Monday, a mid-week day and a Sunday', () => {
    expect(weekStart(at(12))).toBe(at(12)) // Monday at midnight
    expect(weekStart(at(12, 9, 30))).toBe(at(12)) // Monday morning
    expect(weekStart(at(14, 15))).toBe(at(12)) // Wednesday
    expect(weekStart(NOW)).toBe(at(12)) // Sunday 18th
    expect(weekStart(at(19, 8))).toBe(at(19)) // the next Monday
  })
})

describe('relTime', () => {
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime()
  it('says how long ago', () => {
    expect(relTime(NOW - 20_000, NOW)).toBe('just now')
    expect(relTime(NOW - 5 * MIN, NOW)).toBe('5 min ago')
    expect(relTime(NOW - 2 * HOUR, NOW)).toBe('2 h ago')
    expect(relTime(at(17, 18, 5), NOW)).toBe('yesterday 18:05')
    expect(relTime(at(12, 9, 30), NOW)).toBe('Mon 09:30')
    expect(relTime(at(3, 9, 30), NOW)).toBe('3 Oct 09:30')
  })
  it('says when, for the future', () => {
    expect(relTime(NOW + 20_000, NOW)).toBe('in a moment')
    expect(relTime(NOW + 20 * MIN, NOW)).toBe('in 20 min')
    expect(relTime(at(18, 17, 30), NOW)).toBe('today 17:30')
    expect(relTime(at(18, 21, 0), NOW)).toBe('tonight 21:00')
    expect(relTime(at(19, 2, 0), NOW)).toBe('tonight 02:00')
    expect(relTime(at(19, 9, 30), NOW)).toBe('tomorrow 09:30')
    expect(relTime(at(21, 9, 30), NOW)).toBe('Wed 09:30')
    expect(relTime(at(30, 9, 30), NOW)).toBe('30 Oct 09:30')
  })
})
