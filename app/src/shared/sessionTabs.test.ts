import { describe, expect, it } from 'vitest'
import { cleanTabs, closeTab, openTab, pruneSessions, TERMINAL, tabId, type SessionTabsState } from './sessionTabs'

const a = { kind: 'file', path: 'a.ts' } as const
const b = { kind: 'file', path: 'b.md' } as const
const d = { kind: 'diff', path: 'a.ts', base: 'uncommitted' } as const
const start: SessionTabsState = { tabs: [TERMINAL], active: 'terminal' }

describe('tabId', () => {
  it('names each kind', () => {
    expect(tabId(TERMINAL)).toBe('terminal')
    expect(tabId(a)).toBe('file:a.ts')
    expect(tabId(d)).toBe('diff:uncommitted:a.ts')
  })
})

describe('openTab', () => {
  it('adds after the active tab and makes it active', () => {
    const s1 = openTab(start, a)
    expect(s1).toEqual({ tabs: [TERMINAL, a], active: 'file:a.ts' })
    const s2 = openTab({ ...openTab(s1, b), active: 'terminal' }, d)
    expect(s2.tabs.map(tabId)).toEqual(['terminal', 'diff:uncommitted:a.ts', 'file:a.ts', 'file:b.md'])
    expect(s2.active).toBe('diff:uncommitted:a.ts')
  })
  it('only focuses a tab that is already open', () => {
    const s = openTab(openTab(start, a), b)
    expect(openTab(s, a)).toEqual({ tabs: s.tabs, active: 'file:a.ts' })
  })
  it('opens the terminal by focusing it', () => {
    expect(openTab(openTab(start, a), TERMINAL).active).toBe('terminal')
  })
})

describe('closeTab', () => {
  const s = openTab(openTab(openTab(start, a), b), d) // terminal, a, b, d; active d
  it('never closes the terminal', () => {
    expect(closeTab(s, 'terminal')).toBe(s)
  })
  it('moves to the right neighbour, else the left', () => {
    const mid = { ...s, active: 'file:b.md' }
    expect(closeTab(mid, 'file:b.md').active).toBe('diff:uncommitted:a.ts')
    expect(closeTab(s, 'diff:uncommitted:a.ts').active).toBe('file:b.md')
  })
  it('keeps the active tab when closing another', () => {
    const r = closeTab(s, 'file:a.ts')
    expect(r.active).toBe('diff:uncommitted:a.ts')
    expect(r.tabs.map(tabId)).toEqual(['terminal', 'file:b.md', 'diff:uncommitted:a.ts'])
  })
  it('ignores an unknown id', () => {
    expect(closeTab(s, 'file:zzz')).toBe(s)
  })
})

describe('cleanTabs', () => {
  it('keeps good tabs, terminal first', () => {
    expect(cleanTabs({ tabs: [a, TERMINAL, d], active: 'file:a.ts' })).toEqual({ tabs: [TERMINAL, a, d], active: 'file:a.ts' })
  })
  it('drops bad shapes, duplicates and unsafe paths', () => {
    const r = cleanTabs({
      tabs: [a, a, { kind: 'file', path: '../x' }, { kind: 'diff', path: 'a', base: 'weird' }, { kind: 'nope' }, null, 3],
      active: 'file:../x',
    })
    expect(r).toEqual({ tabs: [TERMINAL, a], active: 'terminal' })
  })
  it('gives the terminal alone for anything else', () => {
    for (const v of [null, undefined, 'x', [], { tabs: 'x' }]) expect(cleanTabs(v)).toEqual(start)
  })
  it('caps the number of tabs', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ kind: 'file', path: `f${i}.ts` }))
    expect(cleanTabs({ tabs: many, active: 'terminal' }).tabs.length).toBeLessThanOrEqual(41)
  })
})

describe('pruneSessions', () => {
  it('drops sessions no longer listed', () => {
    const store = { k1: start, k2: openTab(start, a) }
    expect(pruneSessions(store, new Set(['k2']))).toEqual({ k2: store.k2 })
  })
})
