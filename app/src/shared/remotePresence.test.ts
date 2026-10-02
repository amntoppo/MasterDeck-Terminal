import { describe, expect, it } from 'vitest'
import { describeDevice, mergePresence, showRemoteDot } from './remotePresence'

describe('mergePresence', () => {
  it('merges connected browsers and live clients, newest first', () => {
    const r = mergePresence(
      [
        { id: 'b1', name: 'Chrome', approvedAt: 1, connected: true, connectedAt: 100, device: 'Chrome on macOS' },
        { id: 'b2', name: 'Off', approvedAt: 1, connected: false, connectedAt: 500 },
        { id: 'b3', name: 'Old web', approvedAt: 1, connected: true },
      ],
      [
        { id: 'c1', kind: 'live', name: 'Pixel', device: 'Android', since: 300 },
        { id: 'c2', kind: 'api', name: 'ci', device: null, since: 50 },
      ],
    )
    expect(r.map((x) => [x.id, x.kind])).toEqual([['c1', 'phone'], ['b1', 'browser'], ['c2', 'api'], ['b3', 'browser']])
    expect(r[3]).toMatchObject({ device: null, since: 0 })
  })
  it('tolerates missing lists', () => expect(mergePresence(undefined, undefined)).toEqual([]))
})

describe('showRemoteDot', () => {
  it('only with connections and never on web', () => {
    expect(showRemoteDot(1, false)).toBe(true)
    expect(showRemoteDot(0, false)).toBe(false)
    expect(showRemoteDot(2, true)).toBe(false)
  })
})

describe('describeDevice', () => {
  it('names the device or falls back', () => {
    expect(describeDevice('Chrome on macOS')).toBe('Chrome on macOS')
    expect(describeDevice(null)).toBe('Unknown device')
    expect(describeDevice('')).toBe('Unknown device')
  })
})
