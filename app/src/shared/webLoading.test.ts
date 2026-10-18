import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from './remote'
import { advance, loadView, startWait, updateText, WEB_LOAD_TIMEOUT_MS, type LoadClock, type LoadInput, type LoadPhase } from './webLoading'

const T = 1_000_000
const online = { online: true, lastSeen: T, appVersion: '0.9.1' }
const at = (over: Partial<LoadInput>, after = 0): LoadInput => ({
  up: true, desktop: online, phase: 'state', reached: over.phase ?? 'state', since: T, now: T + after, ...over,
})
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

  it('the Mac says its state is too large: named at once, with the size, and not "update" (that Mac has the fit)', () => {
    const v = loadView(at({ tooLarge: { bytes: 1_234_567 } }))
    expect(v).toMatchObject({ stage: 'tooLarge', retry: true })
    expect(v.text).toContain('1.2 MB')
    expect(v.text).not.toContain('Update')
  })

  it('a timeout is about the furthest phase reached, even while the socket redials', () => {
    expect(stage(at({ up: false, phase: 'socket', reached: 'handshake' }, late))).toBe('macSilent')
    expect(stage(at({ phase: 'socket', reached: 'handshake' }, late))).toBe('macSilent')
    expect(stage(at({ phase: 'handshake', reached: 'state' }, late))).toBe('noState')
  })
})

describe('the wait clock (advance)', () => {
  const view = (c: LoadClock, phase: LoadPhase, up: boolean, now: number) => loadView({ up, desktop: online, phase, ...c, now }).stage

  it('moves only on progress', () => {
    const c0 = startWait(T)
    const c1 = advance(c0, 'handshake', T + 100)
    expect(c1).toEqual({ reached: 'handshake', since: T + 100 })
    expect(advance(c1, 'socket', T + 200)).toBe(c1)
    expect(advance(c1, 'handshake', T + 300)).toBe(c1)
    expect(advance(c1, 'state', T + 400)).toEqual({ reached: 'state', since: T + 400 })
  })

  it('#172 review: an online Mac that never answers ends on "doesn\'t answer", though the socket redials every 15 s', () => {
    // Each round: socket opens, handshake starts, the handshake timer closes the socket 15 s later, redial after 1 s.
    let c = startWait(T)
    let t = T
    const seen: string[] = []
    for (let round = 0; round < 3; round++) {
      c = advance(c, 'socket', t)
      c = advance(c, 'handshake', (t += 50))
      seen.push(view(c, 'handshake', true, (t += WEB_LOAD_TIMEOUT_MS - 100)))
      t += 100
      c = advance(c, 'socket', t) // closed: back to socket, clock kept
      seen.push(view(c, 'socket', false, (t += 1000)))
    }
    expect(seen[0]).toBe('waitingMac') // just under 15 s of waiting
    expect(seen.slice(1)).toEqual(Array(5).fill('macSilent'))
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
