import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attachIssues,
  isMasterSession,
  deriveMaster,
  deriveNeedsYou,
  issueSessionMark,
  parseLedger,
  parseSnapshot,
  pendingAssign,
  sessionForIssue,
  sessionForProposal,
} from './derive'
import type { Proposal, Session } from './types'

const fx = (f: string) => JSON.parse(readFileSync(resolve(__dirname, '../../test/fixtures', f), 'utf8'))

function sess(p: Partial<Session>): Session {
  const id = p.sessionId ?? Math.random().toString(36).slice(2)
  return {
    key: p.key ?? id,
    sessionId: id,
    name: 'w',
    kind: 'background',
    bgId: 'abcd1234',
    pid: null,
    cwd: '/w',
    state: 'idle',
    rawState: 'idle',
    startedAt: 0,
    issue: null,
    ...p,
  }
}

function prop(p: Partial<Proposal>): Proposal {
  return { id: 1, kind: 'ASSIGN', issue: 1, status: 'proposed', summary: '', message: '', note: null, target: {}, ...p }
}

describe('parseSnapshot / parseLedger', () => {
  it('parses the captured snapshot', () => {
    const s = parseSnapshot(fx('snapshot.json'))
    expect(s.issues.length).toBeGreaterThan(0)
    expect(s.issues[0]).toHaveProperty('currentSprint')
    expect(s.sessionIssue.size).toBeGreaterThan(0)
    expect([...s.sessionPrs.values()].flat().every((u) => /\/pull\/\d+$/.test(u))).toBe(true)
    expect(s.sources.gh).toBe(true)
  })
  it('parses the captured ledger', () => {
    const l = parseLedger(fx('ledger.json'))
    expect(l.proposals.length).toBe(6)
    const assign = l.proposals.find((p) => p.kind === 'ASSIGN')!
    expect(assign.target.spawn?.name).toBeTruthy()
  })
  it("keeps a spawn's account; a malformed login is dropped", () => {
    const l = parseLedger({
      proposals: [
        { id: 1, target: { spawn: { name: 'fix-12', account: 'bob-work' } } },
        { id: 2, target: { spawn: { name: 'fix-13', account: 'bad login!' } } },
        { id: 3, target: { spawn: { name: 'fix-14' } } },
      ],
    })
    expect(l.proposals.map((p) => p.target.spawn?.account)).toEqual(['bob-work', undefined, undefined])
  })
  it("keeps a spawn's model; anything that is not a model name is dropped", () => {
    const l = parseLedger({
      proposals: [
        { id: 1, target: { spawn: { name: 'fix-12', model: 'opus[1m]' } } },
        { id: 2, target: { spawn: { name: 'fix-13', model: '--dangerously-skip-permissions' } } },
        { id: 3, target: { spawn: { name: 'fix-14' } } },
      ],
    })
    expect(l.proposals.map((p) => (p.target.spawn as { model?: string } | undefined)?.model)).toEqual(['opus[1m]', undefined, undefined])
  })
  it('survives garbage', () => {
    expect(parseSnapshot(null).issues).toEqual([])
    expect(parseLedger('nope').proposals).toEqual([])
  })
})

describe('sessionForIssue', () => {
  it('prefers background, then newest, and ignores done', () => {
    const a = sess({ issue: 7, kind: 'interactive', bgId: null, startedAt: 9 })
    const b = sess({ issue: 7, startedAt: 1 })
    const c = sess({ issue: 7, startedAt: 5 })
    const d = sess({ issue: 7, startedAt: 99, state: 'done' })
    expect(sessionForIssue([a, b, c, d], { repo: null, number: 7 })).toBe(c)
  })
  it('returns null when the only owner is done (issue shows as unassigned)', () => {
    const s = [sess({ issue: 7, state: 'done' })]
    expect(sessionForIssue(s, { repo: null, number: 7 })).toBeNull()
    expect(issueSessionMark({ repo: null, number: 7 }, s, [])).toBe('none')
  })
  it('attachIssues fills issue numbers by session id', () => {
    const [x] = attachIssues([sess({ sessionId: 's1' })], new Map([['s1', { repo: null, number: 42 }]]))
    expect(x.issue).toBe(42)
  })
})

describe('deriveMaster', () => {
  it('attached when master is a live background session', () => {
    expect(deriveMaster([sess({ name: 'master-agent' })]).kind).toBe('attached')
  })
  it('elsewhere when master runs interactively in another terminal', () => {
    expect(deriveMaster([sess({ name: 'master-agent', kind: 'interactive', bgId: null })]).kind).toBe('elsewhere')
  })
  it('duplicate when two live rows are named master-agent', () => {
    const m = deriveMaster([sess({ name: 'master-agent' }), sess({ name: 'master-agent', kind: 'interactive' })])
    expect(m).toEqual({ kind: 'duplicate', count: 2 })
  })
  it('absent when the only master row is done', () => {
    expect(deriveMaster([sess({ name: 'master-agent', state: 'done' })]).kind).toBe('absent')
  })
})

describe('deriveNeedsYou', () => {
  it('orders proposed, then attention, then waiting sessions, and skips master', () => {
    const items = deriveNeedsYou(
      [prop({ id: 1 }), prop({ id: 3 }), prop({ id: 2, status: 'question' }), prop({ id: 4, status: 'done' })],
      [sess({ name: 'x', state: 'needs-input' }), sess({ name: 'master-agent', state: 'needs-input' })],
    )
    expect(items.map((i) => (i.kind === 'session' ? i.session.name : `${i.kind}:${i.proposal.id}`))).toEqual([
      'proposal:3',
      'proposal:1',
      'attention:2',
      'x',
    ])
  })
})

describe('pendingAssign / issueSessionMark', () => {
  it('finds an undispatched ASSIGN and marks approved ones as pending', () => {
    const ps = [prop({ id: 5, issue: 9, status: 'approved' }), prop({ id: 6, issue: 9, status: 'sent' })]
    expect(pendingAssign(ps, { repo: null, number: 9 })?.id).toBe(5)
    expect(issueSessionMark({ repo: null, number: 9 }, [], ps)).toBe('pending')
    expect(issueSessionMark({ repo: null, number: 9 }, [sess({ issue: 9 })], ps)).toBe('session')
  })
})

describe('sessionForProposal', () => {
  it('resolves by target session name, then spawn name, then issue owner', () => {
    const a = sess({ name: 'paywall', issue: 3 })
    const b = sess({ name: '9-fix', issue: 9 })
    expect(sessionForProposal(prop({ target: { session: 'paywall' } }), [a, b])).toBe(a)
    expect(sessionForProposal(prop({ target: { spawn: { name: '9-fix' } } }), [a, b])).toBe(b)
    expect(sessionForProposal(prop({ issue: 3, target: {} }), [a, b])).toBe(a)
  })
})

describe('isMasterSession (the reports guard\'s exemption on a resume)', () => {
  const rows = [
    { sessionId: 'm1', key: 'aaaa1111', bgId: 'aaaa1111', name: 'Master-Agent' },
    { sessionId: 's1', key: 'bbbb2222', bgId: 'bbbb2222', name: 'fix-12' },
  ]
  it('goes by the name the session list has for that id, never by what the caller says', () => {
    expect(isMasterSession(rows, 'm1', 'master-agent')).toBe(true)
    expect(isMasterSession(rows, 'aaaa1111', ' master-agent ')).toBe(true)
    expect(isMasterSession(rows, 's1', 'master-agent')).toBe(false)
    expect(isMasterSession(rows, 'unknown', 'master-agent')).toBe(false)
    expect(isMasterSession(null, 'm1', 'master-agent')).toBe(false)
    expect(isMasterSession(rows, 'm1', '')).toBe(false)
  })
})

