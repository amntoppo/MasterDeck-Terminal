import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MEETINGS, IDLE_LIVE, MEETINGS_CONSENT_VERSION, webState, type MeetingLive, type MeetingsSettings } from '@shared/meetings'
import type { MuteApp, MuteReading, MuteRule } from '@shared/meetingMute'

// Plan M in MeetingsIpc: the mic follows the meeting app's mute. Nothing here asks macOS anything
// (every Electron API is a spy), runs the real md-mute or reads a real app.
const electron = vi.hoisted(() => ({
  askForMediaAccess: vi.fn(async () => true),
  getMediaAccessStatus: vi.fn(() => 'granted'),
  isTrustedAccessibilityClient: vi.fn((_prompt: boolean) => true),
  openExternal: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  systemPreferences: {
    askForMediaAccess: electron.askForMediaAccess,
    getMediaAccessStatus: electron.getMediaAccessStatus,
    isTrustedAccessibilityClient: electron.isTrustedAccessibilityClient,
  },
  shell: { openExternal: electron.openExternal },
}))

import { MeetingsIpc, type RecorderLike } from './meetingsIpc'
import type { MuteHelper } from './meetings/muteHelper'

const agreed: MeetingsSettings = { ...DEFAULT_MEETINGS, consentAt: 1, consentVersion: MEETINGS_CONSENT_VERSION }
const local = {}
const remote = { remote: true }

let root: string
let bin: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-meetings-mute-'))
  bin = join(root, 'md-mute')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n')
  chmodSync(bin, 0o755)
  vi.clearAllMocks()
  electron.isTrustedAccessibilityClient.mockImplementation(() => true)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

interface Fake extends MuteHelper {
  rules: readonly MuteRule[]
  killed: boolean
  send(apps: MuteApp[]): void
  exit(): void
}

function setup(o: { m?: MeetingsSettings; platform?: string; spawn?: boolean; env?: NodeJS.ProcessEnv; beforeStart?: () => void } = {}) {
  let settings = o.m ?? agreed
  const events: string[] = []
  const helpers: Fake[] = []
  const state = { recording: false, paused: false }
  const live = (): MeetingLive => (state.recording ? { ...IDLE_LIVE, recording: true, since: 1, paused: state.paused } : IDLE_LIVE)
  const rec: RecorderLike & { recording: boolean } = {
    get recording() {
      return state.recording
    },
    meetingId: null,
    live,
    start: async () => (o.beforeStart?.(), events.push('start'), (state.recording = true), { ok: true, live: live() }),
    stop: async () => (events.push('stop'), (state.recording = false), { ok: true, live: live() }),
    pause: async (p: unknown) => ((state.paused = p === true), { ok: true, live: live() }),
    probe: async () => false,
    setMicGate: (on: boolean) => void events.push(on ? 'gate' : 'ungate'),
  }
  const ipc = new MeetingsIpc({
    platform: o.platform ?? 'darwin',
    meetings: () => settings,
    setMeetings: (n) => (settings = n),
    macosVersion: () => '14.4.1',
    now: () => 1000,
    arch: 'arm64',
    modelsDir: join(root, 'models'),
    whisper: () => ({ env: o.env ?? { MASTERDECK_MUTE: bin }, resourcesPath: root, appRoot: root, packaged: true, arch: 'arm64', pathEnv: '' }),
    progress: () => {},
    restart: async () => false,
    meetingsDir: join(root, 'meetings'),
    capturePage: () => ({ file: '/nonexistent/capture.html' }),
    capturePreload: '/nonexistent/capture.js',
    onLive: () => {},
    notice: () => {},
    makeRecorder: async () => rec,
    loadEngine: async () =>
      ({
        ModelStore: class {
          ready = () => false
          path = () => ''
          status = () => ({ models: [], downloading: null })
          cleanParts = () => {}
          cancel = () => {}
        },
        findWhisper: () => null,
        transcribe: async () => [],
        killRunning: () => {},
      }) as never,
    loadService: async () =>
      ({
        MeetingStore: class {
          list = () => []
          update = () => ({ ok: true })
        },
        Transcriber: class {
          start() {}
          stop() {}
        },
      }) as never,
    ...(o.spawn === false
      ? {}
      : {
          spawnMute: (_bin: string, rules: readonly MuteRule[]) => {
            const lines: ((r: MuteReading) => void)[] = []
            const exits: ((c: number | null, e: string) => void)[] = []
            let t = 0
            const h: Fake = {
              rules,
              killed: false,
              onLine: (cb) => void lines.push(cb),
              onExit: (cb) => void exits.push(cb),
              exit: () => exits.forEach((cb) => cb(1, 'gone')),
              kill: () => {
                h.killed = true
                events.push('kill')
              },
              send: (apps) => lines.forEach((cb) => cb({ t: ++t, trusted: true, apps })),
            }
            events.push('spawn')
            helpers.push(h)
            return h
          },
        }),
  })
  return { ipc, events, helpers, last: () => helpers[helpers.length - 1], set: (m: MeetingsSettings) => (settings = m), state }
}

describe('the mic in MeetingsIpc', () => {
  it('every start sets the gate before Record; md-mute starts just before it; muted gates at once', async () => {
    const t = setup()
    await t.ipc.start(local)
    expect(t.events).toEqual(['ungate', 'spawn', 'start'])
    t.last().send([{ id: 'zoom', state: 'muted' }])
    expect(t.events.at(-1)).toBe('gate')
    expect(t.ipc.live()?.mic).toEqual({ mode: 'follow', app: 'Zoom', state: 'muted', manualOff: false, kept: false, reason: null })
    // Web tabs never learn the call app.
    expect(webState({ meetingLive: t.ipc.live() }).meetingLive?.mic?.app).toBeNull()
    await t.ipc.stop(local)
    expect(t.events.slice(-3)).toEqual(['stop', 'kill', 'ungate'])
    expect(t.ipc.live()?.mic).toBeNull()
    // The next recording starts ungated again, whatever the last one ended with.
    await t.ipc.start(local)
    expect(t.events.slice(-3)).toEqual(['ungate', 'spawn', 'start'])
  })

  it('a muted reading that comes before Record gates before the recording opens the mic', async () => {
    let send: (() => void) | null = null
    const t = setup({ beforeStart: () => send?.() })
    send = () => t.last().send([{ id: 'zoom', state: 'muted' }])
    await t.ipc.start(local)
    expect(t.events).toEqual(['ungate', 'spawn', 'gate', 'start'])
    expect(t.helpers).toHaveLength(1)
    expect(t.ipc.live()?.mic).toMatchObject({ state: 'muted', kept: false })
  })

  it('a recorder change during Record does not kill the md-mute started for it', async () => {
    // The recorder's onChange (syncMute) may fire while start runs, not recording yet: here as a settings sync.
    let during: (() => void) | null = null
    const t = setup({ beforeStart: () => during?.() })
    during = () => t.ipc.settingsChanged()
    await t.ipc.start(local)
    expect(t.events).toEqual(['ungate', 'spawn', 'start'])
    expect(t.last().killed).toBe(false)
  })

  describe('looking again every 5 s while it cannot read', () => {
    beforeEach(() => void vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }))
    afterEach(() => void vi.useRealTimers())

    it('Accessibility allowed during the call: md-mute starts within 5 s, and the looks stop', async () => {
      electron.isTrustedAccessibilityClient.mockImplementation(() => false)
      const t = setup()
      await t.ipc.start(local)
      expect(t.helpers).toHaveLength(0)
      vi.advanceTimersByTime(5000)
      expect(t.helpers).toHaveLength(0)
      electron.isTrustedAccessibilityClient.mockImplementation(() => true)
      vi.advanceTimersByTime(5000)
      expect(t.helpers).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      t.last().send([{ id: 'zoom', state: 'muted' }])
      expect(t.events.at(-1)).toBe('gate')
    })

    it('a helper that ended is started again, at most 3 times per recording', async () => {
      const t = setup()
      await t.ipc.start(local)
      for (let i = 0; i < 3; i++) {
        t.last().exit()
        expect(t.ipc.live()?.mic).toMatchObject({ reason: 'no-helper', kept: true })
        vi.advanceTimersByTime(5000)
        expect(t.helpers).toHaveLength(i + 2)
      }
      t.last().exit()
      vi.advanceTimersByTime(20_000)
      expect(t.helpers).toHaveLength(4)
      expect(vi.getTimerCount()).toBe(0)
      // The next recording may start it again.
      await t.ipc.stop(local)
      await t.ipc.start(local)
      expect(t.helpers).toHaveLength(5)
    })

    it('no looks while paused, in always mode, after stop or a quit', async () => {
      electron.isTrustedAccessibilityClient.mockImplementation(() => false)
      const t = setup()
      await t.ipc.start(local)
      expect(vi.getTimerCount()).toBe(1)
      await t.ipc.pause(local, true)
      expect(vi.getTimerCount()).toBe(0)
      await t.ipc.pause(local, false)
      expect(vi.getTimerCount()).toBe(1)
      t.set({ ...agreed, mic: 'always' })
      t.ipc.settingsChanged()
      expect(vi.getTimerCount()).toBe(0)
      t.set(agreed)
      t.ipc.settingsChanged()
      expect(vi.getTimerCount()).toBe(1)
      await t.ipc.stop(local)
      expect(vi.getTimerCount()).toBe(0)
      await t.ipc.start(local)
      expect(vi.getTimerCount()).toBe(1)
      t.ipc.quit()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('unknown keeps the mic: no gate, the reason says why', async () => {
    const t = setup()
    await t.ipc.start(local)
    t.last().send([{ id: 'zoom', state: 'unknown' }])
    expect(t.events).not.toContain('gate')
    expect(t.ipc.live()?.mic).toMatchObject({ state: 'unknown', kept: true, reason: 'unreadable' })
  })

  it('Accessibility not allowed: no md-mute; the mic records', async () => {
    electron.isTrustedAccessibilityClient.mockImplementation(() => false)
    const t = setup()
    await t.ipc.start(local)
    expect(t.events).toEqual(['ungate', 'start'])
    expect(t.ipc.live()?.mic).toMatchObject({ reason: 'not-trusted', kept: true })
    expect(electron.isTrustedAccessibilityClient.mock.calls.every(([p]) => p === false)).toBe(true)
  })

  it("'always' runs no md-mute; a change of Your microphone mid-recording applies at once", async () => {
    const t = setup({ m: { ...agreed, mic: 'always' } })
    await t.ipc.start(local)
    expect(t.events).toEqual(['ungate', 'start'])
    expect(t.ipc.live()?.mic).toMatchObject({ mode: 'always', kept: true })
    t.set({ ...agreed, mic: 'follow' })
    t.ipc.settingsChanged()
    expect(t.events.at(-1)).toBe('spawn')
    t.last().send([{ id: 'zoom', state: 'muted' }])
    t.set({ ...agreed, mic: 'always' })
    t.ipc.settingsChanged()
    expect(t.events.slice(-2)).toEqual(['kill', 'ungate'])
  })

  it('pause kills md-mute, resume starts it again', async () => {
    const t = setup()
    await t.ipc.start(local)
    expect((await t.ipc.pause(local, true)).ok).toBe(true)
    expect(t.last().killed).toBe(true)
    expect(t.ipc.live()?.mic).toMatchObject({ kept: false })
    await t.ipc.pause(local, false)
    expect(t.helpers).toHaveLength(2)
    expect(t.last().killed).toBe(false)
  })

  it('Mic off in the recording: the window only, only while recording, reset at the next start', async () => {
    const t = setup()
    expect(await t.ipc.micOff(local, true)).toMatchObject({ ok: false })
    await t.ipc.start(local)
    expect(await t.ipc.micOff(remote, true)).toMatchObject({ ok: false })
    expect(await t.ipc.micOff(local, 'yes')).toMatchObject({ ok: false })
    const r = await t.ipc.micOff(local, true)
    expect(r).toMatchObject({ ok: true, live: { mic: { manualOff: true, kept: false } } })
    expect(t.events.at(-1)).toBe('gate')
    await t.ipc.stop(local)
    await t.ipc.start(local)
    expect(t.ipc.live()?.mic).toMatchObject({ manualOff: false, kept: true })
    const win = setup({ platform: 'win32' })
    expect(await win.ipc.micOff(local, true)).toMatchObject({ ok: false })
  })

  it('Turn off meetings and a quit kill md-mute', async () => {
    const t = setup()
    await t.ipc.start(local)
    await t.ipc.consent(local, false)
    expect(t.last().killed).toBe(true)
    const q = setup()
    await q.ipc.start(local)
    q.ipc.quit()
    expect(q.last().killed).toBe(true)
  })

  it('no call app offered: md-mute gets every rule (the offered one alone: mute.test.ts)', async () => {
    const t = setup()
    await t.ipc.start(local)
    expect(t.last().rules.length).toBeGreaterThan(1)
  })

  it.skipIf(process.platform === 'win32')('a stand-in md-mute (MASTERDECK_MUTE) through the real spawn: its muted line gates', { timeout: 20_000 }, async () => {
    const stand = join(root, 'stand-in')
    writeFileSync(stand, '#!/bin/bash\nread -r rules\nwhile true; do echo \'{"t":1,"trusted":true,"apps":[{"id":"zoom","state":"muted"}]}\'; sleep 0.05; done\n')
    chmodSync(stand, 0o755)
    const t = setup({ spawn: false, env: { MASTERDECK_MUTE: stand } })
    await t.ipc.start(local)
    await vi.waitFor(() => expect(t.events).toContain('gate'), { timeout: 5000 })
    expect(t.ipc.live()?.mic).toMatchObject({ app: 'Zoom', state: 'muted', kept: false })
    await t.ipc.stop(local)
    expect(t.events.at(-1)).toBe('ungate')
  })
})
