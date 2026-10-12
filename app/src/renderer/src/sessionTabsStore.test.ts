import { describe, expect, it } from 'vitest'
import { TERMINAL } from '@shared/sessionTabs'
import { SessionTabsStore, type KeyValue } from './sessionTabsStore'

const fakeStorage = (init: Record<string, string> = {}): KeyValue & { data: Record<string, string> } => {
  const data = { ...init }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    },
  }
}
const file = (path: string) => ({ kind: 'file' as const, path })

describe('SessionTabsStore', () => {
  it('starts every session with the terminal alone', () => {
    const s = new SessionTabsStore(fakeStorage())
    expect(s.get('k1')).toEqual({ tabs: [TERMINAL], active: 'terminal' })
  })
  it('keeps tabs per session and saves them', () => {
    const storage = fakeStorage()
    const s = new SessionTabsStore(storage)
    s.open('k1', file('a.ts'))
    s.open('k2', file('b.md'))
    expect(s.get('k1').active).toBe('file:a.ts')
    expect(s.get('k2').tabs).toHaveLength(2)
    // A new store (a restart) reads them back.
    const again = new SessionTabsStore(storage)
    expect(again.get('k1')).toEqual({ tabs: [TERMINAL, file('a.ts')], active: 'file:a.ts' })
  })
  it('closes, activates and tells listeners', () => {
    const s = new SessionTabsStore(fakeStorage())
    let calls = 0
    const off = s.subscribe(() => calls++)
    s.open('k1', file('a.ts'))
    s.activate('k1', 'terminal')
    expect(s.get('k1').active).toBe('terminal')
    s.activate('k1', 'file:nope')
    expect(s.get('k1').active).toBe('terminal')
    s.close('k1', 'file:a.ts')
    expect(s.get('k1')).toEqual({ tabs: [TERMINAL], active: 'terminal' })
    expect(calls).toBe(3)
    off()
    s.open('k1', file('x.ts'))
    expect(calls).toBe(3)
  })
  it('tells who wants to know that a tab was opened (the phone closes its panel)', () => {
    const s = new SessionTabsStore(fakeStorage())
    const opened: string[] = []
    const off = s.onOpen((key) => opened.push(key))
    s.open('k1', file('a.ts'))
    s.open('k1', file('a.ts')) // focusing an open tab counts too
    s.activate('k1', 'terminal')
    off()
    s.open('k2', file('b.ts'))
    expect(opened).toEqual(['k1', 'k1'])
  })
  it('reads bad stored data as nothing', () => {
    expect(new SessionTabsStore(fakeStorage({ 'session-tabs': '{oops' })).get('k1').tabs).toEqual([TERMINAL])
    expect(new SessionTabsStore(fakeStorage({ 'session-tabs': '[1,2]' })).get('k1').tabs).toEqual([TERMINAL])
    const s = new SessionTabsStore(fakeStorage({ 'session-tabs': JSON.stringify({ k1: { tabs: [{ kind: 'file', path: '../x' }], active: 'x' } }) }))
    expect(s.get('k1')).toEqual({ tabs: [TERMINAL], active: 'terminal' })
  })
  it('drops sessions no longer listed', () => {
    const storage = fakeStorage()
    const s = new SessionTabsStore(storage)
    s.open('k1', file('a.ts'))
    s.open('k2', file('b.ts'))
    s.prune(new Set(['k2']))
    expect(Object.keys(JSON.parse(storage.data['session-tabs']))).toEqual(['k2'])
  })
  it('returns the same object while nothing changed (for useSyncExternalStore)', () => {
    const s = new SessionTabsStore(fakeStorage())
    expect(s.get('k1')).toBe(s.get('k1'))
  })
  it('survives storage that throws', () => {
    const s = new SessionTabsStore({
      getItem: () => {
        throw new Error('no')
      },
      setItem: () => {
        throw new Error('no')
      },
    })
    s.open('k1', file('a.ts'))
    expect(s.get('k1').active).toBe('file:a.ts')
  })
})
