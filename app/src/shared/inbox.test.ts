import { describe, expect, it } from 'vitest'
import { allowed, collectItems, inboxNotice, type InboxInput } from './inbox'
import { DEFAULT_SETTINGS } from './settings'
import { MOD_VERSION } from './modBand'
import { parseTicket } from './ticket'
import type { ExternalItem } from './remote'
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
  it('a GitHub account that needs to log in again is one item with Log in; healthy ones are not', () => {
    const items = collectItems(input({ ghAccounts: [{ login: 'alice', primary: true, healthy: true }, { login: 'bob-work', primary: false, healthy: false, error: 'the token no longer works' }] }))
    expect(items.map((i) => [i.id, i.kind, i.sessionKey, i.actions.map((a) => a.type)])).toEqual([['account:bob-work', 'account', null, ['login']]])
    expect(items[0].body).toContain('bob-work needs to log in again (the token no longer works)')
    expect(allowed(items[0], 'login')).toBe(true)
  })
  it('an account notice is an item with no action but dismiss and snooze', () => {
    const items = collectItems(input({ accountNotices: [{ id: 'gh-active:bob-work:alice', text: 'switch' }] }))
    expect(items.map((i) => [i.id, i.kind, i.actions.length, i.body])).toEqual([['notice:gh-active:bob-work:alice', 'account', 0, 'switch']])
    expect(allowed(items[0], 'login')).toBe(false)
  })
  it('sessions on older mods: one item per mods version, Reload only while one is idle', () => {
    const [item] = collectItems(input({ modsReload: { keys: ['a', 'b'], idle: ['a'] } }))
    expect([item.id, item.kind, item.sessionKey, item.actions]).toEqual([`mods:${MOD_VERSION}`, 'mods', null, [{ type: 'reload', label: 'Reload the idle session', primary: true }]])
    expect(item.detail).toEqual({ type: 'mods', keys: ['a', 'b'], idle: ['a'] })
    expect(allowed(item, 'reload')).toBe(true)
    expect(inboxNotice({ item, state: 'open', firstSeen: 0, lastSeen: 0 })?.action?.type).toBe('reload')
    const [none] = collectItems(input({ modsReload: { keys: ['b'], idle: [] } }))
    expect(none.actions).toEqual([])
    expect(allowed(none, 'reload')).toBe(false)
    expect(collectItems(input({ modsReload: null }))).toEqual([])
  })
  it('leaves review offers to the PR watch, keeps CI offers', () => {
    const pr = { url: 'https://github.com/acme/web/pull/3', repo: 'web', number: 3, title: 't', unresolvedThreads: 2, ci: 'failure', headRef: 'f', refsIssue: null, authorIsMe: true } as InboxInput['prs'][number]
    const kinds = (watched: string[]) => collectItems({ ...input({}), prs: [pr], watchedPrs: new Set(watched) }).map((i) => i.kind).filter((k) => k === 'review' || k === 'ci').sort()
    expect(kinds([])).toEqual(['ci', 'review'])
    expect(kinds([pr.url])).toEqual(['ci'])
  })
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

  describe('a start Claude Code refused because its folder is not trusted', () => {
    const note = 'Workspace not trusted. Run `claude` in code/api once and accept the trust prompt, then retry.'
    const spawn = { name: '7-x', cwd: 'code/api', prompt: 'go' }
    it('can be fixed and tried again from the item', () => {
      const [h] = collectItems(input({ proposals: [prop({ id: 85, status: 'held', heldFor: 'trust', note, target: { spawn } })] }))
      expect([h.kind, h.actions]).toEqual(['held', [{ type: 'trust', label: 'Open Claude there…' }, { type: 'approve', label: 'Try again', primary: true }]])
      expect(h.body).toBe('Claude Code has not been allowed to work in code/api yet. Open Claude in that folder once and accept its prompt, then try again.')
      expect(allowed(h, 'approve')).toBe(true)
      expect(allowed(h, 'trust')).toBe(true)
      expect(h.detail).toMatchObject({ type: 'proposal', proposal: { id: 85 } })
    })
    it('the item is the same one while the refusal is', () => {
      const id = () => collectItems(input({ proposals: [prop({ id: 85, status: 'held', heldFor: 'trust', note, target: { spawn } })] }))[0].id
      expect(id()).toBe(id())
    })
    it('held for any other reason stays as it was: nothing to press but Open', () => {
      // The last one: a note that only reads like the refusal (master-agent wrote it), not held by `master spawn`.
      for (const p of [prop({ status: 'held', note: 'cwd does not exist: code/api', target: { spawn } }), prop({ status: 'held', heldFor: 'trust', note, target: { session: 'a' } }), prop({ status: 'held' }), prop({ status: 'held', note, target: { spawn } })]) {
        const [h] = collectItems(input({ proposals: [p] }))
        expect(h.actions).toEqual([{ type: 'open', label: 'Open' }])
        expect(h.body).toBe(p.note ?? p.summary)
        expect(allowed(h, 'approve')).toBe(false)
      }
    })
  })
})

describe('external items', () => {
  const ext = (over: Partial<ExternalItem> = {}): ExternalItem => ({
    id: 'ext-1', title: 'Deploy?', body: 'prod', options: ['yes', 'no'], allowText: false, priority: 85, createdAt: 1, by: 'client:test',
    state: 'open', answer: null, answeredBy: null, answeredAt: null, callbackStatus: 'none', callbackAttempts: 0, ticket: 'o/r#7', ...over,
  })

  it('become Needs-you items with their options', () => {
    const [i] = collectItems(input({ external: [ext()] }))
    expect(i).toMatchObject({ id: 'ext-1', kind: 'external', priority: 85, title: 'Deploy?', body: 'prod', ticket: parseTicket('o/r#7'), detail: { type: 'external' } })
    expect(i.actions).toEqual([{ type: 'option', label: 'yes' }, { type: 'option', label: 'no' }])
    expect(allowed(i, 'option')).toBe(true)
    expect(allowed(i, 'reply')).toBe(true)
  })

  it('free text adds an Answer action', () => {
    const [i] = collectItems(input({ external: [ext({ options: undefined, allowText: true, ticket: undefined })] }))
    expect(i.actions).toEqual([{ type: 'reply', label: 'Answer' }])
    expect(i.ticket).toBeNull()
  })

  it('stay while open even if their session is gone; a known session keeps its key', () => {
    const items = collectItems(input({ sessions: [sess('a')], external: [ext({ id: 'e-gone', sessionKey: 'gone' }), ext({ id: 'e-known', sessionKey: 'a' })] }))
    expect(items.find((x) => x.id === 'e-gone')?.sessionKey).toBeNull()
    expect(items.find((x) => x.id === 'e-known')?.sessionKey).toBe('a')
  })
})
