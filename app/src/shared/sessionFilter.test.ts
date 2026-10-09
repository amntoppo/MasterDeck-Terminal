import { describe, expect, it } from 'vitest'
import type { Lane } from './tasks'
import {
  GH_ACTIVE,
  NO_FILTER,
  accountChoicesFor,
  activeChips,
  cleanFilter,
  folderChoices,
  folderLabel,
  isFiltered,
  matches,
  sessionFolder,
  type Filterable,
  type FilterContext,
  type SessionFilter,
} from './sessionFilter'

const lanes: Record<string, Lane> = { a: 'working', b: 'you', c: 'idle' }
const s = (key: string, o: Partial<Filterable> = {}): Filterable => ({ key, name: key, cwd: '/w/app', lane: lanes[key] ?? 'idle', ...o })
const ctx = (o: Partial<FilterContext> = {}): FilterContext => ({
  stars: [],
  multi: true,
  ...o,
})
const f = (o: Partial<SessionFilter>): SessionFilter => ({ ...NO_FILTER, ...o })

describe('sessionFolder', () => {
  it('counts a worktree under its repository', () => {
    expect(sessionFolder('/w/app/.claude/worktrees/app-74-x')).toBe('/w/app')
    expect(sessionFolder('/w/app/.claude/worktrees/app-74-x/sub')).toBe('/w/app')
  })
  it('keeps any other folder as it is, without a trailing slash', () => {
    expect(sessionFolder('/w/app/')).toBe('/w/app')
    expect(sessionFolder('C:\\w\\app')).toBe('C:/w/app')
  })
  it('labels a folder by its last part', () => {
    expect(folderLabel('/w/app')).toBe('app')
  })
})

describe('matches', () => {
  it('lets everything through with no filter', () => {
    expect(matches(s('a'), NO_FILTER, ctx())).toBe(true)
  })
  it('filters by status lane, any of the picked ones', () => {
    const fl = f({ status: ['you', 'idle'] })
    expect(matches(s('a'), fl, ctx())).toBe(false)
    expect(matches(s('b'), fl, ctx())).toBe(true)
    expect(matches(s('c'), fl, ctx())).toBe(true)
  })
  it('filters by account, gh active included', () => {
    const fl = f({ accounts: ['ann', GH_ACTIVE] })
    expect(matches(s('a', { account: 'ann' }), fl, ctx())).toBe(true)
    expect(matches(s('a', { account: 'bob' }), fl, ctx())).toBe(false)
    expect(matches(s('a', { ghActive: true }), fl, ctx())).toBe(true)
    expect(matches(s('a'), fl, ctx())).toBe(false)
  })
  it('ignores the account filter with fewer than two accounts', () => {
    expect(matches(s('a', { account: 'bob' }), f({ accounts: ['ann'] }), ctx({ multi: false }))).toBe(true)
  })
  it('filters by folder, worktrees under their repository', () => {
    const fl = f({ folders: ['/w/app'] })
    expect(matches(s('a', { cwd: '/w/app/.claude/worktrees/x' }), fl, ctx())).toBe(true)
    expect(matches(s('a', { cwd: '/w/web' }), fl, ctx())).toBe(false)
  })
  it('filters by star', () => {
    expect(matches(s('a'), f({ starred: true }), ctx({ stars: ['a'] }))).toBe(true)
    expect(matches(s('b'), f({ starred: true }), ctx({ stars: ['a'] }))).toBe(false)
  })
  it('searches the name and ticket, every word, any case', () => {
    const x = s('a', { name: 'Fix-Login-Bug', ticket: '#74' })
    expect(matches(x, f({ q: 'login' }), ctx())).toBe(true)
    expect(matches(x, f({ q: 'bug #74' }), ctx())).toBe(true)
    expect(matches(x, f({ q: 'login board' }), ctx())).toBe(false)
    expect(matches(x, f({ q: '   ' }), ctx())).toBe(true)
  })
  it('combines kinds: every one must match', () => {
    const fl = f({ status: ['working'], starred: true, q: 'a' })
    expect(matches(s('a'), fl, ctx({ stars: ['a'] }))).toBe(true)
    expect(matches(s('a'), fl, ctx())).toBe(false)
    expect(matches(s('a'), { ...fl, status: ['idle'] }, ctx({ stars: ['a'] }))).toBe(false)
  })
})

describe('activeChips', () => {
  it('lists each filter that is on, each removable on its own', () => {
    const fl = f({ q: ' log ', starred: true, status: ['you'], accounts: ['ann'], folders: ['/w/app'] })
    const chips = activeChips(fl, true)
    expect(chips.map((c) => c.label)).toEqual(['“log”', '★ Starred', 'Needs you', '@ann', 'app'])
    expect(chips[2].without.status).toEqual([])
    expect(chips[2].without.starred).toBe(true)
    expect(chips[3].without.accounts).toEqual([])
  })
  it('does not count an account filter with one account', () => {
    expect(activeChips(f({ accounts: ['ann'] }), false)).toEqual([])
    expect(isFiltered(f({ accounts: ['ann'] }), false)).toBe(false)
    expect(isFiltered(f({ accounts: ['ann'] }), true)).toBe(true)
  })
})

describe('choices', () => {
  it('offers each folder once, by name, and keeps a picked one', () => {
    const list = [{ cwd: '/w/web' }, { cwd: '/w/app/.claude/worktrees/x' }, { cwd: '/w/app' }]
    expect(folderChoices(list, ['/old/zed'])).toEqual(['/w/app', '/w/web', '/old/zed'])
  })
  it("offers gh's active account only when a session runs as it", () => {
    expect(accountChoicesFor(['ann', 'bob'], [s('a')], [])).toEqual(['ann', 'bob'])
    expect(accountChoicesFor(['ann'], [s('a', { ghActive: true })], ['gone'])).toEqual(['ann', GH_ACTIVE, 'gone'])
  })
})

describe('cleanFilter', () => {
  it('drops what it does not know', () => {
    expect(cleanFilter(null)).toEqual(NO_FILTER)
    expect(cleanFilter({ q: 3, status: ['you', 'nope', 1], accounts: 'ann', folders: ['/w'], starred: 'yes' })).toEqual(
      f({ status: ['you'], folders: ['/w'] }),
    )
  })
})
