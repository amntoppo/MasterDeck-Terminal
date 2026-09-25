import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attachIssues,
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
    expect(sessionForIssue([a, b, c, d], 7)).toBe(c)
  })
  it('returns null when the only owner is done (issue shows as unassigned)', () => {
    const s = [sess({ issue: 7, state: 'done' })]
    expect(sessionForIssue(s, 7)).toBeNull()
    expect(issueSessionMark(7, s, [])).toBe('none')
  })
  it('attachIssues fills issue numbers by session id', () => {
    const [x] = attachIssues([sess({ sessionId: 's1' })], new Map([['s1', 42]]))
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
    expect(pendingAssign(ps, 9)?.id).toBe(5)
    expect(issueSessionMark(9, [], ps)).toBe('pending')
    expect(issueSessionMark(9, [sess({ issue: 9 })], ps)).toBe('session')
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
