import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseConfig, setConfig } from './appConfig'
import { MOD_BEAT_STALE_MS, MOD_VERSION, bandFor, boardKeyOf, mergeCatalog, modBand, modBoard, modRows, modsStale, parseModBeat, type ModSeen } from './modBand'
import type { Board, BoardCard, Session } from './types'

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

  it('is there for a session with no ticket, PR or link too (its board key), and skips ended peers', () => {
    setConfig(cfg)
    const s = session({ issue: null })
    const done = session({ key: 'k2', name: 'old', state: 'done' })
    expect(modBand(state({ sessions: [s, done], peers: { k1: ['k2'] } }), s, 'acme')).toEqual({ v: 1, name: 'tracker-12-login', ticket: null, status: null, pr: null, peers: [], boardKey: 'acme' })
  })
})

const card = (number: number, status: string | null, over: Partial<BoardCard> = {}): BoardCard => ({
  number, repo: null, title: `Card ${number}`, url: `https://github.com/acme/tracker/issues/${number}`, status, prs: [], assignees: ['alice'], labels: [], milestone: null, type: null, ...over,
})

// An account with a GitHub board (without one, tabBoard keeps only the derived cards).
const boarded = parseConfig({ owner: 'acme', issueRepo: 'tracker', projects: [{ owner: 'acme', number: 1, title: 'Delivery', columns: ['Todo', 'In Dev'] }] })

describe('modBoard', () => {
  afterEach(() => setConfig(DEFAULT_CONFIG))

  it('gives the board\'s columns in order with their cards, a "No status" column for the rest', () => {
    setConfig(boarded)
    const board: Board = { takenAt: null, sprint: 'Sprint 7', columns: ['Todo', 'In Dev'], cards: [card(1, 'In Dev'), card(2, 'Todo'), card(3, null), card(4, 'In Dev', { title: 'x'.repeat(200) })] }
    const b = modBoard(board, '_', boarded)!
    expect(b.sprint).toBe('Sprint 7')
    expect(b.derived).toBe(false)
    expect(b.columns.map((c) => [c.name, c.count, c.cards.map((x) => x.label)])).toEqual([
      ['Todo', 1, ['#2']],
      ['In Dev', 2, ['#1', '#4']],
      ['No status', 1, ['#3']],
    ])
    expect(b.columns[1].cards[1].title.length).toBe(120)
    expect(modBoard(null, '_', boarded)).toBeNull()
  })

  it('lists at most 30 cards a column, and counts them all', () => {
    setConfig(boarded)
    const cards = Array.from({ length: 45 }, (_, i) => card(i + 1, 'Todo'))
    const col = modBoard({ takenAt: null, sprint: null, columns: ['Todo'], cards }, '_', boarded)!.columns[0]
    expect([col.count, col.cards.length]).toEqual([45, 30])
  })

  it('reads the session\'s account, else the primary\'s', () => {
    const two = parseConfig({ config: { accounts: [
      { login: 'alice', primary: true, owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker'] },
      { login: 'bob-work', owner: 'globex', issueRepo: 'app', repos: ['globex/app'] },
    ] } })
    expect(boardKeyOf(session({ account: 'bob-work' }), two)).toBe('bob-work')
    expect(boardKeyOf(session(), two)).toBe('alice')
  })
})

describe('bandFor', () => {
  const band = { v: 1 as const, name: 's', ticket: null, status: 'In Dev', pr: null, peers: [] }
  it('carries the mods switched off', () => {
    expect(bandFor(band, [])).toBe(band)
    expect(bandFor(band, ['masterdeck-alerts'])).toEqual({ ...band, offMods: ['masterdeck-alerts'] })
  })
})

const seen = (name: string, over: Partial<ModSeen> = {}): ModSeen => ({ name, provenance: `${name}@acme`, version: '1.0.0', tier: 'user', loaded: true, ...over })

describe('the mods catalog', () => {
  it('adds new mods and updates changed ones, and says when nothing changed', () => {
    const one = mergeCatalog([], [seen('token-chart')])!
    expect(one).toEqual([{ name: 'token-chart', provenance: 'token-chart@acme', version: '1.0.0', tier: 'user' }])
    expect(mergeCatalog(one, [seen('token-chart', { loaded: false })])).toBeNull()
    expect(mergeCatalog(one, [seen('token-chart', { version: '1.1.0' }), seen('blast-radius')])?.map((e) => [e.name, e.version])).toEqual([['blast-radius', '1.0.0'], ['token-chart', '1.1.0']])
  })
})

describe('modRows', () => {
  it('lists the core (locked), MasterDeck\'s feature mods, then each other mod with how it stands in this session', () => {
    const catalog = [
      { name: 'token-chart', provenance: 'token-chart@acme', version: '1.0.0', tier: 'user' },
      { name: 'replay', provenance: 'replay@acme', version: '0.2.0', tier: 'user' },
      { name: 'old', provenance: 'old@acme', version: null, tier: 'user' },
      { name: 'diff', provenance: 'diff@builtin', version: null, tier: 'builtin' },
      { name: 'masterdeck-ticket', provenance: 'masterdeck-ticket@masterdeck', version: '0.4.0', tier: 'user' },
    ]
    const live = {
      version: '0.4.0',
      mods: [
        seen('masterdeck-ticket', { provenance: 'masterdeck-ticket@masterdeck', version: '0.4.0' }),
        seen('masterdeck-alerts', { provenance: 'masterdeck-alerts@masterdeck', version: '0.4.0' }),
        seen('token-chart'), seen('replay', { loaded: false }), seen('blast', { loaded: false }),
        seen('diff', { tier: 'builtin', provenance: 'diff@builtin' }),
      ],
    }
    const rows = modRows(catalog, live, ['masterdeck-alerts', 'token-chart', 'replay'])
    expect(rows.map((r) => [r.name, r.title, r.status, r.isOff, r.locked, r.isMasterDeck])).toEqual([
      ['masterdeck', 'MasterDeck core', 'on', false, true, true],
      ['masterdeck-ticket', 'Ticket line', 'on', false, false, true],
      ['masterdeck-alerts', 'Alerts', 'off', true, false, true],
      ['masterdeck-note', 'Note command', 'not-seen', false, false, true],
      ['masterdeck-loop', 'Agent loop', 'not-seen', false, false, true],
      ['masterdeck-board', 'Board', 'not-seen', false, false, true],
      ['blast', 'blast', 'turning-on', false, false, false],
      ['old', 'old', 'not-seen', false, false, false],
      ['replay', 'replay', 'off', true, false, false],
      ['token-chart', 'token-chart', 'off-next-start', true, false, false],
      ['diff', 'diff', 'on', false, true, false],
    ])
    expect(modRows([], { version: '0.4.0', mods: [] }, []).map((r) => r.name)).toEqual(['masterdeck', 'masterdeck-ticket', 'masterdeck-alerts', 'masterdeck-note', 'masterdeck-loop', 'masterdeck-board'])
  })
})

describe('modsStale', () => {
  const all = ['masterdeck-ticket', 'masterdeck-alerts', 'masterdeck-note', 'masterdeck-loop', 'masterdeck-board'].map((n) => seen(n))
  it('is true for an older core, or a MasterDeck mod the session has not loaded', () => {
    expect(modsStale({ version: MOD_VERSION, mods: all })).toBe(false)
    expect(modsStale({ version: '0.3.0', mods: all })).toBe(true)
    expect(modsStale({ version: MOD_VERSION, mods: all.slice(1) })).toBe(true)
  })
})

describe('parseModBeat', () => {
  const now = 1_000_000
  it('takes a fresh beat', () => {
    expect(parseModBeat(JSON.stringify({ v: 1, version: '0.1.0', claude: '2.1.296', at: now - 20_000 }), now)).toEqual({ version: '0.1.0', claude: '2.1.296', at: now - 20_000, mods: [] })
    const mods = [seen('token-chart', { loaded: false }), { name: 'bad name', provenance: 'x', tier: 'user' }, 7]
    expect(parseModBeat(JSON.stringify({ v: 1, version: '0.3.0', at: now, mods }), now)?.mods).toEqual([seen('token-chart', { loaded: false })])
  })
  it('drops stale, ended, broken and foreign files', () => {
    expect(parseModBeat(JSON.stringify({ v: 1, version: '0.1.0', at: now - MOD_BEAT_STALE_MS }), now)).toBeNull()
    expect(parseModBeat(JSON.stringify({ v: 1, version: '0.1.0', at: now, ended: true }), now)).toBeNull()
    expect(parseModBeat('{', now)).toBeNull()
    expect(parseModBeat(JSON.stringify({ v: 2, version: '0.1.0', at: now }), now)).toBeNull()
    expect(parseModBeat('null', now)).toBeNull()
  })
})
