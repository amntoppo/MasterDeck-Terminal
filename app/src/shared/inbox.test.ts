import { describe, expect, it } from 'vitest'
import { allowed, collectItems, inboxNotice, type InboxInput } from './inbox'
import { DEFAULT_SETTINGS } from './settings'
import type { Pr, Proposal, Session } from './types'

const NOW = 10_000_000
const sess = (key: string, o: Partial<Session> = {}): Session => ({
  key,
  sessionId: `id-${key}`,
  name: key,
  kind: 'background',
  bgId: 'abcd1234',
  pid: 1,
  cwd: '/',
  state: 'idle',
  rawState: 'idle',
  startedAt: 1,
  issue: null,
  ...o,
})
const prop = (o: Partial<Proposal>): Proposal => ({ id: 1, kind: 'ASSIGN', issue: 7, status: 'proposed', summary: 'S', message: 'M', note: null, target: {}, ...o })
const input = (o: Partial<InboxInput>): InboxInput => ({
  sessions: [],
  proposals: [],
  menus: {},
  lastActivity: {},
  settings: DEFAULT_SETTINGS,
  allStats: {},
  costBook: {},
  prs: [],
  sessionPrs: {},
  now: NOW,
  ...o,
})

describe('collectItems', () => {
  it('builds each kind with a stable id, priority order and its actions', () => {
    const a = sess('a', { state: 'needs-input' })
    const b = sess('b', { issue: 7 })
    const items = collectItems(
      input({
        sessions: [a, b],
        proposals: [
          prop({ id: 1, status: 'proposed', kind: 'CHAT', target: { session: 'b' } }),
          prop({ id: 2, status: 'question', note: 'A or B?', target: { session: 'b' } }),
        ],
        lastActivity: { 'id-a': 500 },
        allStats: { 'id-b': { contextPct: 91 } },
      }),
    )
    expect(items.map((i) => [i.id, i.kind, i.priority])).toEqual([
      ['wait:a:500', 'input', 100],
      ['question:2:' + items[1].id.split(':')[2], 'question', 90],
      ['proposal:1', 'proposal', 60],
      ['context:b:9', 'context', 30],
    ])
    expect(items[1].body).toBe('A or B?')
    expect(items[1].actions.map((x) => x.type)).toEqual(['reply', 'open'])
    expect(items[2].actions.map((x) => x.type)).toEqual(['approve', 'reject'])
    expect(items[3].actions[0]).toMatchObject({ type: 'compact', primary: true })
  })

  it('a menu found on the screen is the same wait (same item), now a menu', () => {
    const a = sess('a', { state: 'needs-input' })
    const menu = { tabs: [], question: { question: 'Colour?', header: 'C', multiSelect: false, options: [] }, checked: [], review: null }
    const [plain] = collectItems(input({ sessions: [a], lastActivity: { 'id-a': 7 } }))
    const [m] = collectItems(input({ sessions: [a], menus: { a: menu }, lastActivity: { 'id-a': 7 } }))
    expect(m.id).toBe(plain.id)
    expect(m.kind).toBe('menu')
    expect(m.body).toBe('Colour?')
  })

  it('a new question on the same proposal is a new item; ASSIGN with a spawn starts', () => {
    const q = (note: string) => collectItems(input({ proposals: [prop({ id: 3, status: 'question', note })] }))[0].id
    expect(q('one')).not.toBe(q('two'))
    const [s] = collectItems(input({ proposals: [prop({ id: 4, target: { spawn: { name: 'x', prompt: 'p' } } })] }))
    expect(s.actions[0].type).toBe('start')
  })

  it('budget and PR offers; failing CI outranks proposals', () => {
    const pr: Pr = { url: 'https://github.com/o/r/pull/9', repo: 'r', number: 9, title: 'T', unresolvedThreads: 2, ci: 'failure', headRef: 'b', refsIssue: null }
    const items = collectItems(
      input({
        prs: [pr],
        costBook: { s: { name: 'x', key: 'x', issue: 5, days: { '0000-baseline': 50 } } },
        proposals: [prop({ id: 1 })],
      }),
    )
    expect(items.map((i) => i.kind)).toEqual(['ci', 'proposal', 'review', 'budget'])
    expect(items[0].id).toBe('offer:ci:https://github.com/o/r/pull/9')
    expect(items[3].id).toMatch(/^budget:.*#5:2$/)
  })

  it('only the actions an item has, plus reply for questions', () => {
    const [q] = collectItems(input({ proposals: [prop({ status: 'question', note: 'x' })] }))
    expect(allowed(q, 'reply')).toBe(true)
    expect(allowed(q, 'option')).toBe(true)
    expect(allowed(q, 'approve')).toBe(false)
  })

  it('notices for every new item but held ones', () => {
    const [q] = collectItems(input({ proposals: [prop({ status: 'question', note: 'A or B?' })] }))
    const e = { item: q, state: 'open' as const, firstSeen: 0, lastSeen: 0 }
    expect(inboxNotice(e)).toMatchObject({ title: '#7: question', body: 'A or B?' })
    const [i] = collectItems(input({ sessions: [sess('a', { state: 'idle' })], proposals: [prop({ status: 'sent', target: { session: 'a' } })], lastActivity: { 'id-a': 0 } }))
    expect(i.kind).toBe('idle')
    // Every new item gets one, with the action it can take from the notification.
    expect(inboxNotice({ ...e, item: i })).toMatchObject({ title: 'a went quiet', action: { type: 'continue' }, reply: false })
    expect(inboxNotice(e)).toMatchObject({ reply: true, target: { itemId: q.id } })
    const [h] = collectItems(input({ proposals: [prop({ status: 'held' })] }))
    expect(inboxNotice({ ...e, item: h })).toBeNull()
  })
})
