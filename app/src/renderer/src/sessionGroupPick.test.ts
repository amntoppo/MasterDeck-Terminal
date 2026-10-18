import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
})

describe('sessionGroupPick', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })
  it('starts on All, or on the tab remembered in localStorage', async () => {
    expect((await import('./sessionGroupPick')).pickedGroup()).toBe('all')
    vi.resetModules()
    store.set('sessionGroup', JSON.stringify('g00000001'))
    expect((await import('./sessionGroupPick')).pickedGroup()).toBe('g00000001')
  })
  it('remembers a pick for the next window (the key the Sidebar always used)', async () => {
    const m = await import('./sessionGroupPick')
    m.pickGroup('g00000002')
    expect(m.pickedGroup()).toBe('g00000002')
    expect(JSON.parse(store.get('sessionGroup')!)).toBe('g00000002')
  })
})
