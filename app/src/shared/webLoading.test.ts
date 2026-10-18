import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from './remote'
import { loadView, updateText, WEB_LOAD_TIMEOUT_MS, type LoadInput } from './webLoading'

const T = 1_000_000
const online = { online: true, lastSeen: T, appVersion: '0.9.1' }
const at = (over: Partial<LoadInput>, after = 0): LoadInput => ({ up: true, desktop: online, phase: 'state', since: T, now: T + after, ...over })
const stage = (i: LoadInput) => loadView(i).stage
const late = WEB_LOAD_TIMEOUT_MS

describe('loadView (#168: the loading screen never waits for ever)', () => {
  it('socket: Connecting…, then the server is named with Retry', () => {
    expect(loadView(at({ up: false, desktop: null, phase: 'socket' }))).toMatchObject({ stage: 'connecting', text: 'Connecting…', retry: false })
    expect(loadView(at({ up: false, desktop: null, phase: 'socket' }, late))).toMatchObject({ stage: 'unreachable', retry: true })
  })

  it('a socket that is down counts as connecting whatever the phase', () => {
    expect(stage(at({ up: false, phase: 'state' }))).toBe('connecting')
  })

  it('socket open, the hub has not named the Mac yet: waiting for the Mac; offline wins once it is said', () => {
    expect(stage(at({ desktop: null, phase: 'socket' }))).toBe('waitingMac')
    expect(stage(at({ desktop: { online: false, lastSeen: null, appVersion: null }, phase: 'socket' }))).toBe('offline')
  })

  it('Mac offline: says so at once, with when it was last seen and Retry', () => {
    const v = loadView(at({ desktop: { online: false, lastSeen: T - 3 * 60_000, appVersion: '0.9.1' }, phase: 'handshake' }))
    expect(v).toMatchObject({ stage: 'offline', title: 'Your Mac is offline', retry: true })
    expect(v.text).toContain('Last seen 3m ago')
    expect(loadView(at({ desktop: { online: false, lastSeen: null, appVersion: null } })).text).not.toContain('Last seen')
  })

  it('handshake: Waiting for your Mac…, then "doesn\'t answer" with its version', () => {
    expect(loadView(at({ phase: 'handshake' }))).toMatchObject({ stage: 'waitingMac', text: 'Waiting for your Mac…', retry: false })
    const v = loadView(at({ phase: 'handshake' }, late))
    expect(v).toMatchObject({ stage: 'macSilent', retry: true })
    expect(v.text).toContain('MasterDeck 0.9.1')
  })

  it('no word from the hub yet: waiting, not offline', () => {
    expect(stage(at({ desktop: null, phase: 'handshake' }))).toBe('waitingMac')
  })

  it('hello, no state: Loading sessions…, then the reason and Retry after the timeout', () => {
    expect(loadView(at({}, late - 1))).toMatchObject({ stage: 'loadingSessions', text: 'Loading sessions…', retry: false })
    const v = loadView(at({}, late))
    expect(v).toMatchObject({ stage: 'noState', retry: true })
    expect(v.text).toContain('Update MasterDeck on your Mac')
  })

  it('the Mac says its state is too large: named at once, with the size', () => {
    const v = loadView(at({ tooLarge: { bytes: 1_234_567 } }))
    expect(v).toMatchObject({ stage: 'tooLarge', retry: true })
    expect(v.text).toContain('1.2 MB')
  })
})

describe('updateText (protocol mismatch)', () => {
  it('an older Mac: update the Mac, with both versions', () => {
    const t = updateText({ appVersion: '0.5.0', protocol: PROTOCOL_VERSION - 1 })
    expect(t).toContain('MasterDeck 0.5.0')
    expect(t).toContain(`needs protocol ${PROTOCOL_VERSION}`)
    expect(t).toContain('Update MasterDeck on your Mac')
  })

  it('a newer Mac: reload this page', () => {
    expect(updateText({ appVersion: '9.0.0', protocol: PROTOCOL_VERSION + 1 })).toContain('Reload this page')
  })
})
