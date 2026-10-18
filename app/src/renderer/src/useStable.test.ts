import { describe, expect, it } from 'vitest'
import { stableNext } from './useStable'

describe('stableNext', () => {
  it('keeps the first reference while the JSON is the same', () => {
    const a = stableNext(null, { n: 1, list: ['x'] })
    const b = stableNext(a, { n: 1, list: ['x'] })
    expect(b).toBe(a)
    expect(b.v).toBe(a.v)
  })
  it('takes the new value when anything in it changed', () => {
    const a = stableNext(null, { n: 1, list: ['x'] })
    const b = stableNext(a, { n: 1, list: ['x', 'y'] })
    expect(b).not.toBe(a)
    expect(b.v.list).toEqual(['x', 'y'])
  })
  it('handles null and undefined', () => {
    const a = stableNext<unknown>(null, null)
    expect(stableNext(a, null)).toBe(a)
    const u = stableNext<unknown>(null, undefined)
    expect(stableNext(u, undefined)).toBe(u)
    expect(stableNext(u, null)).not.toBe(u)
  })
})
