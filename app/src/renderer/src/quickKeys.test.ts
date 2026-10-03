import { describe, expect, it, vi, afterEach } from 'vitest'
import { QUICK_KEYS, quickKeyBytes } from './quickKeys'
import { isPhone } from './web'

describe('quick keys', () => {
  it('sends the bytes xterm sends for each key', () => {
    expect(QUICK_KEYS.map((k) => quickKeyBytes(k))).toEqual(['\x1b', '\t', '\x1b[Z', '\x03', '\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C', '\r', 'y', 'n', '/'])
  })
  it('arrows follow application cursor mode', () => {
    expect(quickKeyBytes('↑', true)).toBe('\x1bOA')
    expect(quickKeyBytes('←', true)).toBe('\x1bOD')
    expect(quickKeyBytes('Esc', true)).toBe('\x1b')
  })
})

describe('isPhone', () => {
  afterEach(() => vi.unstubAllGlobals())
  const at = (platform: string, narrow: boolean) => {
    vi.stubGlobal('window', { deck: { platform } })
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: narrow && q === '(max-width: 760px)' }))
    return isPhone()
  }
  it('is the web app in a narrow window only', () => {
    expect(at('web', true)).toBe(true)
    expect(at('web', false)).toBe(false)
    expect(at('darwin', true)).toBe(false) // Electron never
    expect(at('win32', true)).toBe(false)
  })
})
