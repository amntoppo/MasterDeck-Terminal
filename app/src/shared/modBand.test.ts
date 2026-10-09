import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseConfig, setConfig } from './appConfig'
import { MOD_BEAT_STALE_MS, modBand, parseModBeat } from './modBand'
import type { Session } from './types'

const cfg = parseConfig({ config: { owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'] } })

function session(over: Partial<Session> = {}): Session {
  return {
    key: 'k1', sessionId: '11111111-1111-1111-1111-111111111111', name: 'tracker-12-login',
    kind: 'background', bgId: 'k1', pid: 1, cwd: '/w/tracker', state: 'working', rawState: 'working',
    startedAt: 0, issue: 12, issueRepo: null, ...over,
  }
}

type Part = Parameters<typeof modBand>[0]
function state(over: Partial<Part> = {}): Part {
  return { sessions: [session()], issues: [], board: null, prs: [], prLive: {}, sessionPrs: {}, peers: {}, ...over }
}

const PR = 'https://github.com/acme/tracker/pull/90'

describe('modBand', () => {
  afterEach(() => setConfig(DEFAULT_CONFIG))

  it('gives the ticket, its column, the session PR and linked sessions', () => {
    setConfig(cfg)
    const other = session({ key: 'k2', sessionId: '22222222-2222-2222-2222-222222222222', name: 'api-3', state: 'idle', issue: 3, issueRepo: 'acme/api' })
    const st = state({
      sessions: [session(), other],
      board: { takenAt: null, sprint: null, columns: ['Todo', 'In Dev'], cards: [{ number: 12, repo: null, title: 'Login', url: 'https://github.com/acme/tracker/issues/12', status: 'In Dev', prs: [], assignees: [], labels: [], milestone: null, type: null }] },
      prs: [{ url: PR, repo: 'tracker', number: 90, title: 'Login', unresolvedThreads: 2, ci: 'success', headRef: 'login', refsIssue: 12 }],
      prLive: { [PR]: { number: 90, title: 'Login', url: PR, state: 'OPEN', reviewDecision: null, ci: 'success', reviewCheck: null, buildCi: 'success', isDraft: false, createdAt: null, mergedAt: null, lastCommentAt: null } },
      sessionPrs: { '11111111-1111-1111-1111-111111111111': ['https://github.com/acme/tracker/pull/80', PR] },
      peers: { k1: ['k2'], k2: ['k1'] },
    })
    expect(modBand(st, session())).toEqual({
      v: 1,
      name: 'tracker-12-login',
      ticket: { label: '#12', ref: 'acme/tracker#12', title: 'Login', url: 'https://github.com/acme/tracker/issues/12' },
      status: 'In Dev',
      pr: { number: 90, url: PR, state: 'OPEN', ci: 'success', threads: 2, draft: false },
      peers: [{ name: 'api-3', state: 'idle' }],
    })
  })

  it('names a ticket of another repository by it, with no board card', () => {
    setConfig(cfg)
    const s = session({ issue: 3, issueRepo: 'acme/api' })
    const b = modBand(state({ sessions: [s] }), s)
    expect(b?.ticket).toEqual({ label: 'api#3', ref: 'acme/api#3', title: null, url: 'https://github.com/acme/api/issues/3' })
    expect(b?.status).toBeNull()
    expect(b?.pr).toBeNull()
  })

  it('reads the PR number from its URL before the PR is read', () => {
    setConfig(cfg)
    const b = modBand(state({ sessionPrs: { '11111111-1111-1111-1111-111111111111': [PR] } }), session())
    expect(b?.pr).toEqual({ number: 90, url: PR, state: null, ci: null, threads: 0, draft: false })
  })

  it('is null for a session with no ticket, PR or linked session, and skips ended peers', () => {
    setConfig(cfg)
    const s = session({ issue: null })
    const done = session({ key: 'k2', name: 'old', state: 'done' })
    expect(modBand(state({ sessions: [s, done], peers: { k1: ['k2'] } }), s)).toBeNull()
  })
})

describe('parseModBeat', () => {
  const now = 1_000_000
  it('takes a fresh beat', () => {
    expect(parseModBeat(JSON.stringify({ v: 1, version: '0.1.0', claude: '2.1.296', at: now - 20_000 }), now)).toEqual({ version: '0.1.0', claude: '2.1.296', at: now - 20_000 })
  })
  it('drops stale, ended, broken and foreign files', () => {
    expect(parseModBeat(JSON.stringify({ v: 1, version: '0.1.0', at: now - MOD_BEAT_STALE_MS }), now)).toBeNull()
    expect(parseModBeat(JSON.stringify({ v: 1, version: '0.1.0', at: now, ended: true }), now)).toBeNull()
    expect(parseModBeat('{', now)).toBeNull()
    expect(parseModBeat(JSON.stringify({ v: 2, version: '0.1.0', at: now }), now)).toBeNull()
    expect(parseModBeat('null', now)).toBeNull()
  })
})
