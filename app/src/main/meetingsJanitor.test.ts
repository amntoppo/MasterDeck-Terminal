import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MEETINGS, MEETINGS_CONSENT_VERSION, MEETINGS_MAC_ONLY, type MeetingsSettings } from '@shared/meetings'
import { AUDIO_SWEEP_EVERY_MS, AUDIO_SWEEP_FIRST_MS, DAY_MS } from '@shared/meetingJanitor'

// Nothing here may ask macOS anything: every Electron API is a spy.
vi.mock('electron', () => ({
  systemPreferences: { askForMediaAccess: vi.fn(), getMediaAccessStatus: vi.fn(() => 'not-determined') },
  desktopCapturer: { getSources: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

import { MeetingsIpc, type MeetingsDeps } from './meetingsIpc'
import { MeetingStore } from './meetings/store'

const agreed: MeetingsSettings = { ...DEFAULT_MEETINGS, consentAt: 1, consentVersion: MEETINGS_CONSENT_VERSION }
const local = {}
const remote = { remote: true }
const NOW = 400 * DAY_MS
const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function janitor(m: MeetingsSettings = agreed, over: Partial<MeetingsDeps> = {}, sub = '') {
  const root = mkdtempSync(join(tmpdir(), 'md-meetings-janitor-'))
  dirs.push(root)
  const dir = sub ? join(root, sub) : root
  const changed: (string | null)[] = []
  const cleared: string[] = []
  const asked: string[] = []
  let settings = m
  let loads = 0
  const ipc = new MeetingsIpc({
    platform: 'darwin',
    meetings: () => settings,
    setMeetings: () => {},
    macosVersion: () => '14.4.1',
    arch: 'arm64',
    modelsDir: join(root, 'models'),
    whisper: () => ({ env: {}, resourcesPath: '', appRoot: '', packaged: true, arch: 'arm64', pathEnv: '' }),
    progress: () => {},
    restart: async () => false,
    meetingsDir: dir,
    capturePage: () => ({ file: '/nonexistent/capture.html' }),
    capturePreload: '/nonexistent/capture.js',
    onLive: () => {},
    notice: () => {},
    now: () => Date.now(),
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
    loadService: async () => {
      loads++
      return { ...(await import('./meetings/store')), ...(await import('./meetings/transcriber')) }
    },
    notices: { set: () => {}, clear: (id) => (cleared.push(id), true) },
    changed: (id) => changed.push(id),
    confirm: async (o) => (asked.push(o.message), true),
    ...over,
  })
  const store = new MeetingStore(dir)
  const make = (title: string, started: number, audio = true) => {
    const r = store.create({ title, titleBy: 'user', model: null, language: 'auto' })
    if (!r.ok) throw new Error(r.message)
    store.update(r.meeting.id, (x) => ({ ...x, started, ended: started + 60_000, state: 'done', segments: [{ start: 0, end: 500, speaker: 'others', text: 'hello alice' }] }))
    if (audio) store.appendAudio(r.meeting.id, new Uint8Array([1, 2, 3]))
    return r.meeting.id
  }
  const hasAudio = (id: string) => existsSync(join(dir, id, 'audio.webm'))
  return { ipc, dir, store, make, hasAudio, changed, cleared, asked, loads: () => loads, set: (s: MeetingsSettings) => (settings = s) }
}

describe('meetings:janitor', () => {
  it('lists every meeting with its audio and transcript size', async () => {
    const j = janitor()
    const a = j.make('A', 1000)
    const b = j.make('B', 2000, false)
    const r = await j.ipc.janitor(local)
    if (!r.ok) throw new Error(r.message)
    expect(r.rows.map((x) => x.id)).toEqual([b, a])
    expect(r.rows[1]).toMatchObject({ id: a, title: 'A', started: 1000, audioBytes: 3, recording: false })
    expect(r.rows[0]!.audioBytes).toBe(0)
    expect(r.rows[0]!.transcriptBytes).toBeGreaterThan(0)
  })

  it('refuses a browser and any OS but macOS; works without consent', async () => {
    const j = janitor(DEFAULT_MEETINGS)
    j.make('A', 1000)
    expect((await j.ipc.janitor(remote)).ok).toBe(false)
    expect((await j.ipc.clean(remote, { ids: [], what: 'audio' })).ok).toBe(false)
    const r = await j.ipc.janitor(local)
    expect(r.ok && r.rows).toHaveLength(1)
    const win = janitor(agreed, { platform: 'win32' })
    expect(await win.ipc.janitor(local)).toEqual({ ok: false, message: MEETINGS_MAC_ONLY })
    expect(await win.ipc.clean(local, { ids: [], what: 'audio' })).toEqual({ ok: false, message: MEETINGS_MAC_ONLY })
  })
})

describe('meetings:clean', () => {
  it('Delete audio asks on the Mac, then keeps the transcripts', async () => {
    let answer = false
    const asked: string[] = []
    const j = janitor(agreed, { confirm: async (o) => (asked.push(`${o.message} ${o.detail}`), answer) })
    const a = j.make('A', 1000)
    const b = j.make('B', 2000)
    expect(await j.ipc.clean(local, { ids: [a, b], what: 'audio' })).toEqual({ ok: false, message: 'cancelled' })
    expect(j.hasAudio(a) && j.hasAudio(b)).toBe(true)
    answer = true
    expect(await j.ipc.clean(local, { ids: [a, b], what: 'audio' })).toEqual({ ok: true, done: 2, skipped: 0 })
    expect(asked[0]).toBe('Delete the audio of 2 meetings? The transcripts and the notes they added stay.')
    expect(j.hasAudio(a) || j.hasAudio(b)).toBe(false)
    expect(j.store.get(a)?.segments).toHaveLength(1)
    expect(j.changed).toContain(null)
  })

  it('Delete meetings goes the page’s way: out of the queue, off disk, its item cleared', async () => {
    const j = janitor()
    const a = j.make('A', 1000)
    const svc = await j.ipc.loadService()
    const forget = vi.spyOn(svc.transcriber, 'forget')
    expect(await j.ipc.clean(local, { ids: [a], what: 'meetings' })).toEqual({ ok: true, done: 1, skipped: 0 })
    expect(forget).toHaveBeenCalledWith(a)
    expect(j.store.get(a)).toBeNull()
    expect(existsSync(join(j.dir, a))).toBe(false)
    expect(j.cleared).toContain(a)
    expect(j.asked).toEqual(['Delete this meeting?'])
  })

  it('a bad request is refused; a gone meeting is skipped', async () => {
    const j = janitor()
    const a = j.make('A', 1000)
    expect(await j.ipc.clean(local, { ids: ['../x'], what: 'audio' })).toEqual({ ok: false, message: 'Not a cleanup.' })
    expect(await j.ipc.clean(local, { ids: [a], what: 'notes' })).toEqual({ ok: false, message: 'Not a cleanup.' })
    const gone = `m-${'f'.repeat(32)}`
    expect(await j.ipc.clean(local, { ids: [gone, a], what: 'meetings' })).toEqual({ ok: true, done: 1, skipped: 1 })
  })

  it('the meeting being recorded is never cleaned', async () => {
    const j = janitor(agreed, {
      makeRecorder: async () =>
        ({ recording: true, meetingId: null, live: () => ({}), start: async () => ({}), stop: async () => ({}), pause: async () => ({}), probe: async () => true }) as never,
    })
    const a = j.make('A', 1000)
    const b = j.make('B', 2000)
    const rec = await j.ipc.loadRecorder()
    ;(rec as { meetingId: string | null }).meetingId = a
    const r = await j.ipc.janitor(local)
    expect(r.ok && r.rows.find((x) => x.id === a)?.recording).toBe(true)
    expect(await j.ipc.clean(local, { ids: [a, b], what: 'meetings' })).toEqual({ ok: true, done: 1, skipped: 1 })
    expect(j.store.get(a)).not.toBeNull()
    j.asked.length = 0
    expect(await j.ipc.clean(local, { ids: [a], what: 'audio' })).toEqual({ ok: true, done: 0, skipped: 1 })
    expect(j.hasAudio(a)).toBe(true)
    // Nothing to clean: nothing asked.
    expect(j.asked).toEqual([])
  })
})

describe('Delete audio after (the daily timer)', () => {
  it('first five minutes after start, then daily: older meetings lose their audio, never their transcript', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
    const j = janitor({ ...DEFAULT_MEETINGS, deleteAudioAfterDays: 30 })
    const old = j.make('Old', NOW - 40 * DAY_MS)
    const fresh = j.make('Fresh', NOW - 29.5 * DAY_MS)
    j.ipc.background()
    await vi.advanceTimersByTimeAsync(AUDIO_SWEEP_FIRST_MS - 1000)
    expect(j.hasAudio(old)).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(j.hasAudio(old)).toBe(false)
    expect(j.store.get(old)?.segments).toHaveLength(1)
    expect(j.hasAudio(fresh)).toBe(true)
    // A day later the fresh one is past 30 days too.
    await vi.advanceTimersByTimeAsync(AUDIO_SWEEP_EVERY_MS)
    expect(j.hasAudio(fresh)).toBe(false)
    expect(j.store.get(fresh)).not.toBeNull()
    j.ipc.stopBackground()
  })

  it('nothing is deleted when the setting is never', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
    const j = janitor({ ...DEFAULT_MEETINGS, deleteAudioAfterDays: null })
    const old = j.make('Old', NOW - 400 * DAY_MS + 1)
    j.ipc.background()
    await vi.advanceTimersByTimeAsync(AUDIO_SWEEP_FIRST_MS + 3 * AUDIO_SWEEP_EVERY_MS)
    expect(j.hasAudio(old)).toBe(true)
    expect(j.loads()).toBe(0)
    j.ipc.stopBackground()
  })

  it('loads nothing when there is no meetings folder, and nothing off macOS', async () => {
    const j = janitor(agreed, {}, 'meetings')
    expect(await j.ipc.sweepAudio()).toBe(0)
    expect(j.loads()).toBe(0)
    const win = janitor(agreed, { platform: 'linux' })
    win.make('Old', 1)
    expect(await win.ipc.sweepAudio()).toBe(0)
    win.ipc.background()
    expect(win.loads()).toBe(0)
  })

  it('a meeting being recorded keeps its audio', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const j = janitor({ ...agreed, deleteAudioAfterDays: 7 }, {
      makeRecorder: async () =>
        ({ recording: true, meetingId: null, live: () => ({}), start: async () => ({}), stop: async () => ({}), pause: async () => ({}), probe: async () => true }) as never,
    })
    const a = j.make('Live', NOW - 10 * DAY_MS)
    const b = j.make('Old', NOW - 10 * DAY_MS)
    const rec = await j.ipc.loadRecorder()
    ;(rec as { meetingId: string | null }).meetingId = a
    expect(await j.ipc.sweepAudio()).toBe(1)
    expect(j.hasAudio(a)).toBe(true)
    expect(j.hasAudio(b)).toBe(false)
  })
})
