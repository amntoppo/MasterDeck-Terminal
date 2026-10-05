import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardBadge, cardsIn, moveColumn, NO_STATUS, orderColumns, parseBoard, saveColumnOrder, visibleColumns } from './board'
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
  it('reads the cards of an account with no board, and only then adds the new fields', () => {
    const b = parseBoard({
      cards: [{ number: 3, repo: 'globex/app', status: null, derived: true, state: 'CLOSED', closedAt: '2026-09-20T08:00:00Z' }, { number: 4, derived: true }, { number: 5, state: 'CLOSED' }],
      derived: [{ account: 'bob-work', repos: ['globex/app'], total: 26, shown: 26, skipped: [], missing: ['globex/gone'] }, 'junk'],
    })!
    expect(b.cards.map((c) => [c.derived, c.state, c.closedAt])).toEqual([[true, 'CLOSED', '2026-09-20T08:00:00Z'], [true, 'OPEN', null], [undefined, undefined, undefined]])
    expect(b.derived).toEqual([{ account: 'bob-work', repos: ['globex/app'], total: 26, shown: 26, skipped: [], missing: ['globex/gone'] }])
    expect('derived' in parseBoard({ cards: [] })!).toBe(false)
    // What the read could not do: per account; from a master CLI that only prints them at the top, for the one account there is.
    const part = { repos: ['globex/app'], total: 1, shown: 1, skipped: [], missing: [] }
    expect(parseBoard({ cards: [], derived: [{ ...part, account: 'bob-work', notes: ['globex/api not read: RATE_LIMITED', 7] }, { ...part, account: 'carol' }], notes: ['globex/api not read: RATE_LIMITED'] })!.derived!.map((d) => d.notes)).toEqual([['globex/api not read: RATE_LIMITED'], undefined])
    expect(parseBoard({ cards: [], derived: [{ ...part, account: null }], notes: ['Pull request details not read: HTTP 401'] })!.derived![0].notes).toEqual(['Pull request details not read: HTTP 401'])
    expect('notes' in parseBoard({ cards: [], derived: [{ ...part, account: null }] })!.derived![0]).toBe(false)
    expect('derived' in parseBoard({ cards: [{ number: 1 }] })!.cards[0]).toBe(false)
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

describe('cardBadge with PR statuses', () => {
  const stage = { kind: 'ready' as const, prs: [5], why: 'the automated review passed' }
  it('shows where the PR stands after working, before done and idle', () => {
    const idle = sess({ state: 'idle' })
    const done = prop({ kind: 'ASSIGN', status: 'done' })
    expect(cardBadge({ repo: null, number: 7 }, [idle], [done], [], { [idle.key]: stage })).toEqual({ kind: 'ready', label: 'Ready for Review', detail: 'PR #5: the automated review passed' })
    expect(cardBadge({ repo: null, number: 7 }, [sess({ state: 'working' })], [], [], { [idle.key]: stage }).kind).toBe('working')
    expect(cardBadge({ repo: null, number: 7 }, [idle], [prop({ status: 'question' })], [], { [idle.key]: stage }).kind).toBe('question')
    expect(cardBadge({ repo: null, number: 7 }, [idle], [done]).kind).toBe('done')
  })
})

describe('cardBadge', () => {
  const kind = (s: Session[], p: Proposal[]) => cardBadge({ repo: null, number: 7 }, s, p).kind
  it('question beats a working session and carries the note', () => {
    const b = cardBadge({ repo: null, number: 7 }, [sess({ state: 'working' })], [prop({ status: 'question', note: 'ready for instructions?' })])
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

describe('column order', () => {
  it('orders known columns and keeps new ones in place', () => {
    expect(orderColumns(['A', 'B', 'N', 'C'], ['C', 'A', 'B'])).toEqual(['C', 'A', 'N', 'B'])
    expect(orderColumns(['A', 'B'], [])).toEqual(['A', 'B'])
  })
  it('moves a column', () => {
    expect(moveColumn(['A', 'B', 'C', 'D'], 'A', 3)).toEqual(['B', 'C', 'D', 'A'])
    expect(moveColumn(['A', 'B', 'C', 'D'], 'D', 0)).toEqual(['D', 'A', 'B', 'C'])
    expect(moveColumn(['A', 'B'], 'X', 0)).toEqual(['A', 'B'])
  })
  it('saves a new order and keeps hidden columns in their slots', () => {
    expect(saveColumnOrder(['A', 'H', 'B', 'C'], ['C', 'A', 'B'])).toEqual(['C', 'H', 'A', 'B'])
    expect(saveColumnOrder([], ['B', 'A'])).toEqual(['B', 'A'])
  })
})
