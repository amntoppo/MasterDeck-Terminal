import { describe, expect, it } from 'vitest'
import { PULL_MS, pullDue } from './usePull'

describe('pullDue', () => {
  it('pulls at once the first time, then every PULL_MS', () => {
    expect(pullDue({ now: 1000, last: null, visible: true, changed: false })).toBe(true)
    expect(pullDue({ now: 1000 + PULL_MS - 1, last: 1000, visible: true, changed: false })).toBe(false)
    expect(pullDue({ now: 1000 + PULL_MS, last: 1000, visible: true, changed: false })).toBe(true)
  })
  it('never pulls while hidden', () => {
    expect(pullDue({ now: 99_999, last: null, visible: false, changed: true })).toBe(false)
    expect(pullDue({ now: 99_999, last: 0, visible: false, changed: false })).toBe(false)
  })
  it('pulls at once when the session changed state', () => {
    expect(pullDue({ now: 1001, last: 1000, visible: true, changed: true })).toBe(true)
  })
})
