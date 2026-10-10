import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MEETINGS, MEETINGS_CONSENT_VERSION, type MeetingsSettings } from '@shared/meetings'
import { OFFER_POLL_MS } from '@shared/meetingApps'

// Nothing here may ask macOS anything: every Electron API is a spy.
const electron = vi.hoisted(() => ({
  askForMediaAccess: vi.fn(async () => true),
  getMediaAccessStatus: vi.fn(() => 'not-determined'),
  getSources: vi.fn(async () => []),
  openExternal: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  systemPreferences: { askForMediaAccess: electron.askForMediaAccess, getMediaAccessStatus: electron.getMediaAccessStatus },
  desktopCapturer: { getSources: electron.getSources },
  shell: { openExternal: electron.openExternal },
}))

import { MeetingsIpc, type RecorderLike } from './meetingsIpc'
import * as appsModule from './meetings/apps'

const ZOOM = 'COMM\n/Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost\n'
const agreed: MeetingsSettings = { ...DEFAULT_MEETINGS, consentAt: 1, consentVersion: MEETINGS_CONSENT_VERSION }
const local = {}
const remote = { remote: true }

afterEach(() => vi.useRealTimers())

function offer(m: MeetingsSettings = agreed, platform = 'darwin') {
  let settings = m
  let appsLoads = 0
  const offers: string[] = []
  let lives = 0
  const live = { recording: false, since: null, paused: false, elapsed: 0, offer: null }
  const starts: unknown[] = []
  const rec: RecorderLike & { recording: boolean } = {
    recording: false,
    meetingId: null,
    live: () => ({ ...live, recording: rec.recording }),
    start: async (t?: unknown) => (starts.push(t), (rec.recording = true), { ok: true, live: rec.live() }),
    stop: async () => ((rec.recording = false), { ok: true, live: rec.live() }),
    pause: async () => ({ ok: true, live: rec.live() }),
    probe: async () => false,
  }
  const ps = vi.fn(async () => ZOOM)
  const ipc = new MeetingsIpc({
    platform,
    meetings: () => settings,
    setMeetings: (n) => (settings = n),
    macosVersion: () => '14.4.1',
    now: () => 1000,
    arch: 'arm64',
    modelsDir: '/nonexistent/meetings/models',
    whisper: () => ({ env: {}, resourcesPath: '/nonexistent', appRoot: '/nonexistent', packaged: true, arch: 'arm64', pathEnv: '' }),
    progress: () => {},
    restart: async () => false,
    meetingsDir: '/nonexistent/meetings',
    capturePage: () => ({ file: '/nonexistent/capture.html' }),
    capturePreload: '/nonexistent/capture.js',
    onLive: () => lives++,
    notice: () => {},
    makeRecorder: async () => rec,
    loadEngine: async () =>
      ({
        ModelStore: class {
          ready = () => false
          path = () => ''
          status = () => ({ models: [], downloading: null })
          cleanParts = () => {}
        },
        findWhisper: () => null,
        transcribe: async () => [],
        killRunning: () => {},
      }) as never,
    loadService: async () =>
      ({
        MeetingStore: class {
          list = () => []
          leftovers = () => []
          update = () => ({ ok: true })
        },
        Transcriber: class {
          start() {}
          stop() {}
        },
      }) as never,
    loadApps: async () => (appsLoads++, appsModule),
    ps,
    offer: (a) => offers.push(a),
  })
  return { ipc, ps, offers, starts, rec, lives: () => lives, appsLoads: () => appsLoads, set: (s: MeetingsSettings) => (settings = s) }
}

describe('the offer in MeetingsIpc', () => {
  it('starts 10 s after background() with the consent; offers once; the chip is in meetingLive', async () => {
    vi.useFakeTimers()
    const t = offer()
    t.ipc.background()
    expect(t.appsLoads()).toBe(0)
    await vi.advanceTimersByTimeAsync(OFFER_POLL_MS)
    expect(t.appsLoads()).toBe(1)
    expect(t.ps).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(OFFER_POLL_MS)
    expect(t.offers).toEqual(['Zoom'])
    expect(t.ipc.live()?.offer).toBe('Zoom')
    expect(t.lives()).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(3 * OFFER_POLL_MS)
    expect(t.offers).toEqual(['Zoom'])
    // It never records by itself.
    expect(t.starts).toEqual([])
    expect(electron.askForMediaAccess).not.toHaveBeenCalled()
    t.ipc.quit()
  })

  it('nothing before consent: no load, no ps', async () => {
    vi.useFakeTimers()
    const t = offer(DEFAULT_MEETINGS)
    t.ipc.background()
    await vi.advanceTimersByTimeAsync(10 * OFFER_POLL_MS)
    expect(t.appsLoads()).toBe(0)
    expect(t.ps).not.toHaveBeenCalled()
    t.ipc.stopBackground()
  })

  it('nothing off macOS', async () => {
    vi.useFakeTimers()
    const t = offer(agreed, 'win32')
    t.ipc.background()
    t.ipc.startOffers()
    await vi.advanceTimersByTimeAsync(10 * OFFER_POLL_MS)
    expect(t.appsLoads()).toBe(0)
    expect(t.ipc.live()).toBeNull()
  })

  it('Offer to record off: no ps', async () => {
    vi.useFakeTimers()
    const t = offer({ ...agreed, offer: false })
    t.ipc.startOffers()
    await vi.advanceTimersByTimeAsync(5 * OFFER_POLL_MS)
    expect(t.ps).not.toHaveBeenCalled()
    t.ipc.quit()
  })

  it('Record goes through start (the chip goes, the app is noted); nothing while recording', async () => {
    vi.useFakeTimers()
    const t = offer()
    t.ipc.startOffers()
    await vi.advanceTimersByTimeAsync(OFFER_POLL_MS)
    expect(t.ipc.live()?.offer).toBe('Zoom')
    expect((await t.ipc.start(local)).ok).toBe(true)
    expect(t.starts).toEqual([undefined])
    expect(t.ipc.live()).toMatchObject({ recording: true, offer: null })
    const calls = t.ps.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * OFFER_POLL_MS)
    expect(t.ps.mock.calls.length).toBe(calls)
    // After the recording the same call is not offered again.
    await t.ipc.stop(local)
    await vi.advanceTimersByTimeAsync(3 * OFFER_POLL_MS)
    expect(t.offers).toEqual(['Zoom'])
    t.ipc.quit()
  })

  it('Not now clears the chip for this call; a browser cannot', async () => {
    vi.useFakeTimers()
    const t = offer()
    t.ipc.startOffers()
    await vi.advanceTimersByTimeAsync(OFFER_POLL_MS)
    expect((await t.ipc.notNow(remote)).ok).toBe(false)
    expect(t.ipc.live()?.offer).toBe('Zoom')
    expect(await t.ipc.notNow(local)).toEqual({ ok: true })
    expect(t.ipc.live()?.offer).toBeNull()
    await vi.advanceTimersByTimeAsync(3 * OFFER_POLL_MS)
    expect(t.offers).toEqual(['Zoom'])
    t.ipc.quit()
  })

  it('Turn off meetings stops the looks and the chip; I agree starts them again', async () => {
    vi.useFakeTimers()
    const t = offer()
    t.ipc.startOffers()
    await vi.advanceTimersByTimeAsync(OFFER_POLL_MS)
    expect(t.ipc.live()?.offer).toBe('Zoom')
    await t.ipc.consent(local, false)
    expect(t.ipc.live()?.offer).toBeNull()
    const calls = t.ps.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * OFFER_POLL_MS)
    expect(t.ps.mock.calls.length).toBe(calls)
    await t.ipc.consent(local, true)
    await vi.advanceTimersByTimeAsync(OFFER_POLL_MS)
    // A fresh start: the call still going is offered again once.
    expect(t.offers).toEqual(['Zoom', 'Zoom'])
    expect(t.appsLoads()).toBe(1)
    t.ipc.quit()
  })
})
