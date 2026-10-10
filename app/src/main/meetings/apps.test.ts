import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfferWatch, type OfferWatchDeps } from './apps'

const IDLE = 'COMM\n/sbin/launchd\n/Applications/zoom.us.app/Contents/MacOS/zoom.us\n'
const ZOOM = `${IDLE}/Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost\n`
const WEBEX = `${IDLE}/Applications/Webex.app/Contents/Frameworks/Meeting Center.app/Contents/MacOS/Meeting Center\n`
const BOTH = `${ZOOM}/Applications/Webex.app/Contents/Frameworks/Meeting Center.app/Contents/MacOS/Meeting Center\n`

function watch(over: Partial<OfferWatchDeps> = {}) {
  let out = IDLE
  let allowed = true
  let recording = false
  const offers: string[] = []
  let clears = 0
  const ps = vi.fn(async () => out)
  const w = new OfferWatch({
    ps,
    allowed: () => allowed,
    recording: () => recording,
    offer: (a) => offers.push(a),
    clear: () => clears++,
    ...over,
  })
  return {
    w,
    ps,
    offers,
    clears: () => clears,
    out: (o: string) => (out = o),
    allow: (a: boolean) => (allowed = a),
    record: (r: boolean) => (recording = r),
  }
}

afterEach(() => vi.useRealTimers())

describe('OfferWatch', () => {
  it('one offer per call: not again while it lasts, again for the next call', async () => {
    const t = watch()
    await t.w.tick()
    expect(t.offers).toEqual([])
    t.out(ZOOM)
    await t.w.tick()
    await t.w.tick()
    expect(t.offers).toEqual(['Zoom'])
    expect(t.w.offered).toBe('Zoom')
    // Not now: gone, and not offered again for this call.
    t.w.dismiss()
    expect(t.w.offered).toBeNull()
    await t.w.tick()
    expect(t.offers).toEqual(['Zoom'])
    // The call ends, a new one begins.
    t.out(IDLE)
    await t.w.tick()
    t.out(ZOOM)
    await t.w.tick()
    expect(t.offers).toEqual(['Zoom', 'Zoom'])
  })

  it('the chip goes when the offered call ends', async () => {
    const t = watch()
    t.out(ZOOM)
    await t.w.tick()
    t.out(IDLE)
    await t.w.tick()
    expect(t.w.offered).toBeNull()
    expect(t.clears()).toBe(1)
  })

  it('one chip at a time: a second app in a call meanwhile is not offered later', async () => {
    const t = watch()
    t.out(BOTH)
    await t.w.tick()
    expect(t.offers).toEqual(['Zoom'])
    t.w.dismiss()
    await t.w.tick()
    expect(t.offers).toEqual(['Zoom'])
    t.out(ZOOM)
    await t.w.tick()
    t.out(BOTH)
    await t.w.tick()
    expect(t.offers).toEqual(['Zoom', 'Webex'])
  })

  it('nothing before consent or with offers off: no ps at all', async () => {
    const t = watch()
    t.allow(false)
    t.out(ZOOM)
    await t.w.tick()
    expect(t.ps).not.toHaveBeenCalled()
    expect(t.offers).toEqual([])
  })

  it('nothing while recording; a call that ran during the recording is not new after it', async () => {
    const t = watch()
    t.record(true)
    t.out(ZOOM)
    await t.w.tick()
    expect(t.ps).not.toHaveBeenCalled()
    expect(t.offers).toEqual([])
    // An offer showing when a recording starts goes.
    const u = watch()
    u.out(WEBEX)
    await u.w.tick()
    u.record(true)
    await u.w.tick()
    expect(u.w.offered).toBeNull()
    u.record(false)
    await u.w.tick()
    expect(u.offers).toEqual(['Webex'])
  })

  it('offers turned off while ps ran: no offer', async () => {
    const t = watch()
    t.out(ZOOM)
    t.ps.mockImplementationOnce(async () => {
      t.allow(false)
      return ZOOM
    })
    await t.w.tick()
    expect(t.offers).toEqual([])
  })

  it('a failed ps offers nothing and the next look works', async () => {
    const t = watch()
    t.ps.mockRejectedValueOnce(new Error('ps: timeout'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.out(ZOOM)
    await t.w.tick()
    expect(t.offers).toEqual([])
    await t.w.tick()
    expect(t.offers).toEqual(['Zoom'])
    err.mockRestore()
  })

  it('looks every 10 s once started; stop ends the looks and clears the chip', async () => {
    vi.useFakeTimers()
    const t = watch()
    t.out(ZOOM)
    t.w.start()
    expect(t.ps).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.offers).toEqual(['Zoom'])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.ps).toHaveBeenCalledTimes(4)
    t.w.stop()
    expect(t.w.offered).toBeNull()
    expect(t.w.running).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.ps).toHaveBeenCalledTimes(4)
  })
})
