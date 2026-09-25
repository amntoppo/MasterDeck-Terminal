import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardBadge, cardsIn, NO_STATUS, parseBoard, visibleColumns } from './board'
import type { Board, Proposal, Session } from './types'

const live = JSON.parse(readFileSync(resolve(__dirname, '../../test/fixtures/board.json'), 'utf8'))

function sess(p: Partial<Session>): Session {
  return { key: 'k', sessionId: 's', name: 'w', kind: 'background', bgId: 'abcd1234', pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1, issue: 7, ...p }
}
function prop(p: Partial<Proposal>): Proposal {
  return { id: 1, kind: 'ASSIGN', issue: 7, status: 'sent', summary: '', message: '', note: null, target: {}, ...p }
}

describe('parseBoard', () => {
  it('parses the live board', () => {
    const b = parseBoard(live)!
    expect(b.sprint).toBe('Sprint 6')
    expect(b.cards.length).toBeGreaterThan(0)
    expect(b.cards.flatMap((c) => c.prs).every((p) => typeof p.number === 'number')).toBe(true)
  })
  it('null for garbage, and drops bad PRs', () => {
    expect(parseBoard('x')).toBeNull()
    const b = parseBoard({ cards: [{ number: 1, prs: [{ url: 'u' }, { url: 'u2', number: 2, ci: 'weird', state: null }] }] })!
    expect(b.cards[0].prs).toEqual([{ url: 'u2', repo: '', number: 2, state: null, ci: null, unresolved: 0 }])
    expect(b.cards[0]).toMatchObject({ assignees: [], labels: [], milestone: null, type: null })
  })
})

describe('visibleColumns', () => {
  const b = (statuses: (string | null)[]): Board => ({
    takenAt: null,
    sprint: null,
    columns: ['To Do', 'Ready For Dev', 'In Dev', 'PR Raised', 'Dev Done', 'In QA', 'Blocked', 'Weird'],
    cards: statuses.map((status, i) => ({ number: i, title: '', url: '', status, prs: [], assignees: [], labels: [], milestone: null, type: null })),
  })
  it('always shows the workflow columns, others only with cards', () => {
    expect(visibleColumns(b(['In QA']))).toEqual(['To Do', 'Ready For Dev', 'In Dev', 'PR Raised', 'Dev Done', 'In QA'])
  })
  it('puts No status first and keeps unknown statuses', () => {
    const cols = visibleColumns(b([null, 'Weird']))
    expect(cols[0]).toBe(NO_STATUS)
    expect(cols.at(-1)).toBe('Weird')
    expect(cardsIn(b([null, 'Weird']), NO_STATUS).length).toBe(1)
  })
})

describe('cardBadge', () => {
  const kind = (s: Session[], p: Proposal[]) => cardBadge(7, s, p).kind
  it('question beats a working session and carries the note', () => {
    const b = cardBadge(7, [sess({ state: 'working' })], [prop({ status: 'question', note: 'ready for instructions?' })])
    expect(b).toEqual({ kind: 'question', label: 'Question', detail: 'ready for instructions?' })
  })
  it('blocked, then needs input', () => {
    expect(kind([sess({ state: 'needs-input' })], [prop({ status: 'blocked' })])).toBe('blocked')
    expect(kind([sess({ state: 'needs-input' })], [])).toBe('needs-input')
  })
  it('onboarding while approved, or sent before the session links itself', () => {
    expect(kind([], [prop({ status: 'approved' })])).toBe('onboarding')
    expect(kind([], [prop({ status: 'sent' })])).toBe('onboarding')
    expect(kind([sess({ state: 'working' })], [prop({ status: 'sent' })])).toBe('working')
  })
  it('a newer approved ASSIGN beats an older done one', () => {
    expect(kind([], [prop({ id: 1, status: 'done' }), prop({ id: 5, status: 'approved' })])).toBe('onboarding')
  })
  it('working beats done; done beats idle', () => {
    expect(kind([sess({ state: 'working' })], [prop({ status: 'done' })])).toBe('working')
    expect(kind([sess({ state: 'idle' })], [prop({ status: 'done' })])).toBe('done')
    expect(kind([sess({ state: 'idle' })], [])).toBe('idle')
  })
  it('a session that is done does not count; CHAT proposals are ignored', () => {
    expect(kind([sess({ state: 'done' })], [prop({ kind: 'CHAT', status: 'question' })])).toBe('none')
  })
})
