import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MEETINGS, MEETINGS_CONSENT_VERSION, MEETINGS_MAC_ONLY, type MeetingsSettings } from '@shared/meetings'

// Spec §1: nothing at startup asks macOS for the microphone or the screen, and main/meetings/ is
// loaded only when Settings → Meetings asks. Every Electron media API is a spy here.
const electron = vi.hoisted(() => ({
  askForMediaAccess: vi.fn(async () => true),
  getMediaAccessStatus: vi.fn((_kind: string) => 'not-determined'),
  getSources: vi.fn(async () => []),
  openExternal: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  systemPreferences: { askForMediaAccess: electron.askForMediaAccess, getMediaAccessStatus: electron.getMediaAccessStatus },
  desktopCapturer: { getSources: electron.getSources },
  shell: { openExternal: electron.openExternal },
}))
const gateModule = vi.hoisted(() => ({ imported: 0 }))
vi.mock('./meetings/gate', async (orig) => {
  gateModule.imported++
  return orig()
})

import { guardSessions, MeetingsIpc, type MeetingsDeps, type PermissionSession, type RecorderLike } from './meetingsIpc'
import type { MeetingNotice } from '@shared/meetings'

const MEDIA_APIS = ['askForMediaAccess', 'getUserMedia', 'getDisplayMedia', 'desktopCapturer', 'getMediaAccessStatus']

function mainSources(dir = __dirname, ext = /\.ts$/): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return mainSources(p, ext)
    return ext.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
  })
}

/** A recorder that records nothing: what MeetingsIpc asks of it. */
function fakeRecorder() {
  const calls: string[] = []
  const live = { recording: false, since: null, paused: false, elapsed: 0, offer: null }
  const probeResult = { ok: false }
  const rec: Omit<RecorderLike, 'recording'> & { recording: boolean; calls: string[]; probeResult: { ok: boolean } } = {
    calls,
    probeResult,
    recording: false,
    meetingId: null,
    live: () => live,
    start: async (t?: unknown) => (calls.push(`start:${String(t)}`), { ok: true, live }),
    stop: async (why?: string) => (calls.push(`stop:${why ?? 'user'}`), { ok: true, live }),
    pause: async (p: unknown) => (calls.push(`pause:${String(p)}`), { ok: true, live }),
    probe: async () => (calls.push('probe'), probeResult.ok),
  }
  return rec
}

function setup(over: Partial<{ platform: string; meetings: MeetingsSettings; version: string }> = {}) {
  let m: MeetingsSettings = over.meetings ?? DEFAULT_MEETINGS
  const recorder = fakeRecorder()
  let made = 0
  const ipc = new MeetingsIpc({
    platform: over.platform ?? 'darwin',
    meetings: () => m,
    setMeetings: (n) => {
      m = n
    },
    macosVersion: () => over.version ?? '14.4.1',
    now: () => 1000,
    arch: 'arm64',
    modelsDir: '/nonexistent/meetings/models',
    whisper: () => ({ env: {}, resourcesPath: '/nonexistent', appRoot: '/nonexistent', packaged: true, arch: 'arm64', pathEnv: '' }),
    progress: () => {},
    restart: async () => false,
    meetingsDir: '/nonexistent/meetings',
    capturePage: () => ({ file: '/nonexistent/capture.html' }),
    capturePreload: '/nonexistent/capture.js',
    onLive: () => {},
    notice: () => {},
    makeRecorder: async () => (made++, recorder),
  })
  return { ipc, meetings: () => m, recorder, made: () => made }
}
const agreed = { ...DEFAULT_MEETINGS, consentAt: 1, consentVersion: MEETINGS_CONSENT_VERSION }
const local = {} // the window's IPC event
const remote = { remote: true }

beforeEach(() => {
  vi.clearAllMocks()
  electron.getMediaAccessStatus.mockImplementation(() => 'not-determined')
})

// A static `import … from` / `export … from` of main/meetings/ at any relative depth, over the
// whole file (a clause may span lines); `import type` / `export type` are erased and allowed.
const STATIC_MEETINGS =
  /^\s*(?:(?:import|export)\s+(?!type\b)(?:[\w$*,\s]|\{[^}]*\})*\bfrom\s*|import\s*)["'](?:\.\.?\/)+meetings\//m
const DYNAMIC_MEETINGS = /(?<!typeof )\bimport\(\s*["'](?:\.\.?\/)+meetings\//g

describe('the startup rule', () => {
  it('no main-process or preload file outside main/meetings/ names a media API', () => {
    const preload = join(__dirname, '../preload')
    const files = [...mainSources(), ...mainSources(preload)]
    expect(files.some((f) => f.startsWith(preload))).toBe(true)
    for (const f of files) {
      const rel = relative(__dirname, f)
      if (rel.startsWith('meetings/')) continue
      const src = readFileSync(f, 'utf8')
      for (const api of MEDIA_APIS) expect(src.includes(api), `${rel} names ${api}`).toBe(false)
    }
  })

  it('the static-import check catches what a line-by-line check missed', () => {
    const caught = [
      'import {\n  MeetingsGate,\n  type Grant,\n} from "./meetings/gate";',
      "export { MeetingsGate } from './meetings/gate'",
      "export * from './meetings/gate'",
      "import { MeetingsGate } from '../meetings/gate'",
      "import Gate, * as all from '../../meetings/gate'",
      "import './meetings/gate'",
    ]
    // The check this replaced, run on each line: it let every one of these through.
    const perLine = /^\s*import\s+(?!type\b).*from\s+["']\.\/meetings\//
    for (const s of caught) {
      expect(STATIC_MEETINGS.test(s), s).toBe(true)
      expect(s.split('\n').some((l) => perLine.test(l)), s).toBe(false)
    }
    const allowed = [
      "import type { Gate } from './meetings/gate'",
      'export type {\n  Gate,\n} from "../meetings/gate"',
      "const gate = await import('./meetings/gate')",
      "type G = typeof import('./meetings/gate')",
      "import { x } from './notmeetings/gate'",
    ]
    for (const s of allowed) expect(STATIC_MEETINGS.test(s), s).toBe(false)
  })

  it('main/meetings/ is never imported statically; one dynamic import, in meetingsIpc.ts', () => {
    const dynamic: string[] = []
    for (const f of mainSources()) {
      const rel = relative(__dirname, f)
      if (rel.startsWith('meetings/')) continue
      const src = readFileSync(f, 'utf8')
      const hit = STATIC_MEETINGS.exec(src)
      if (hit) throw new Error(`${rel} imports main/meetings/ at load: ${hit[0].trim()}`)
      for (const m of src.matchAll(DYNAMIC_MEETINGS)) if (m) dynamic.push(rel)
    }
    expect([...new Set(dynamic)]).toEqual(['meetingsIpc.ts'])
  })

  it('index.ts guards the sessions before it opens the first window', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const ready = src.indexOf('app.whenReady().then(')
    expect(ready).toBeGreaterThan(-1)
    const body = src.slice(ready)
    const firstWindow = body.indexOf('createWindow()')
    const guard = body.indexOf('guardSessions(')
    expect(firstWindow).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstWindow)
  })

  it('index.ts guards the sessions and wires the handlers without loading the gate', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(src).toContain('guardSessions(app, session,')
    for (const ch of ['meetingsSetup', 'meetingsConsent', 'meetingsPermission', 'meetingsModel', 'meetingsRestart', 'meetingsStart', 'meetingsStop', 'meetingsPause', 'meetingsRetry', 'meetingsRematch', 'meetingsList', 'meetingsGet', 'meetingsRename', 'meetingsDelete', 'meetingsDeleteAudio', 'meetingsExport', 'meetingsJanitor', 'meetingsClean', 'meetingsNotNow'])
      expect(src).toMatch(new RegExp(`reg\\.handle\\(CH\\.${ch},`))
  })

  it('in the renderer, only the capture window names a capture API; its preload only sends', () => {
    const renderer = join(__dirname, '../renderer/src')
    const named = mainSources(renderer, /\.tsx?$/)
      .filter((f) => ['getUserMedia', 'getDisplayMedia', 'desktopCapturer', 'askForMediaAccess'].some((api) => readFileSync(f, 'utf8').includes(api)))
      .map((f) => relative(renderer, f))
    expect(named).toEqual(['capture.ts'])
    const pre = readFileSync(join(__dirname, '../preload/capture.ts'), 'utf8')
    expect(pre.match(/ipcRenderer\.\w+/g)?.every((m) => m === 'ipcRenderer.send')).toBe(true)
    expect(pre).not.toMatch(/\bfrom ['"](?!electron['"]|@shared\/meetings['"]|@shared\/meetingAudio['"])/)
    // The main window's preload does not load the capture one, and the capture page is its own entry.
    expect(readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')).not.toContain('capture')
  })

  it('what startup runs (the handlers object and the session guard) asks macOS nothing and loads nothing', () => {
    const { ipc } = setup({ meetings: agreed })
    const ses = (): PermissionSession => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() })
    guardSessions({ on: vi.fn() }, { defaultSession: ses(), fromPartition: () => ses() }, () => true)
    expect(ipc.loaded).toBe(false)
    expect(gateModule.imported).toBe(0)
    for (const f of Object.values(electron)) expect(f).not.toHaveBeenCalled()
  })
})

describe('meetings:* handlers', () => {
  it('refuse off macOS and from a browser, before loading anything', async () => {
    const win = setup({ platform: 'win32', meetings: agreed })
    for (const r of [await win.ipc.setup(local), await win.ipc.consent(local, true), await win.ipc.permission(local, 'mic')])
      expect(r).toEqual({ ok: false, message: MEETINGS_MAC_ONLY })
    const mac = setup({ meetings: agreed })
    for (const r of [await mac.ipc.setup(remote), await mac.ipc.consent(remote, true), await mac.ipc.permission(remote, 'mic')]) expect(r.ok).toBe(false)
    expect(win.ipc.loaded || mac.ipc.loaded).toBe(false)
    expect(win.meetings()).toEqual(agreed)
    for (const f of Object.values(electron)) expect(f).not.toHaveBeenCalled()
  })

  it('a permission before consent is refused without loading the gate or asking macOS', async () => {
    const { ipc } = setup()
    expect(await ipc.permission(local, 'mic')).toEqual({ ok: false, message: 'Agree to how meetings work first.' })
    expect(await ipc.permission(local, 'screen')).toMatchObject({ ok: false })
    expect(ipc.loaded).toBe(false)
    expect(electron.askForMediaAccess).not.toHaveBeenCalled()
  })

  it('setup only reads the grants', async () => {
    const { ipc } = setup()
    const r = await ipc.setup(local)
    expect(r).toMatchObject({ ok: true, mac: true, agreed: false, mic: 'not-determined', screen: 'not-checked', systemAudio: 'tap' })
    expect(ipc.loaded).toBe(true)
    // The import detector works: the gate module was loaded now, not before.
    expect(gateModule.imported).toBe(1)
    expect(electron.getMediaAccessStatus).toHaveBeenCalledWith('microphone')
    expect(electron.askForMediaAccess).not.toHaveBeenCalled()
    expect(electron.getSources).not.toHaveBeenCalled()
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('consent stores a time and the version, Turn off clears them, and neither asks macOS', async () => {
    const { ipc, meetings } = setup()
    expect(await ipc.consent(local, 'yes')).toMatchObject({ ok: false })
    expect(await ipc.consent(local, true)).toMatchObject({ ok: true, agreed: true })
    expect(meetings()).toMatchObject({ consentAt: 1000, consentVersion: MEETINGS_CONSENT_VERSION })
    expect(await ipc.consent(local, false)).toMatchObject({ ok: true, agreed: false })
    expect(meetings()).toMatchObject({ consentAt: null, consentVersion: 0, offer: true })
    expect(electron.askForMediaAccess).not.toHaveBeenCalled()
  })

  it('Turn off during a recording stops it first, while the consent still holds', async () => {
    const t = setup({ meetings: agreed })
    await t.ipc.start(local, 'Standup')
    let agreedAtStop: number | null = null
    t.recorder.recording = true
    t.recorder.stop = async (why?: string) => {
      t.recorder.calls.push(`stop:${why}`)
      agreedAtStop = t.meetings().consentAt
      t.recorder.recording = false
      return { ok: true, live: t.recorder.live() }
    }
    expect(await t.ipc.consent(local, false)).toMatchObject({ ok: true, agreed: false })
    expect(t.recorder.calls).toEqual(['start:Standup', 'stop:consent'])
    expect(agreedAtStop).toBe(1)
    expect(t.meetings()).toMatchObject({ consentAt: null })
    // Nothing recording: Turn off stops nothing.
    await t.ipc.consent(local, true)
    await t.ipc.consent(local, false)
    expect(t.recorder.calls).toEqual(['start:Standup', 'stop:consent'])
  })

  it('an older consent version is no consent', async () => {
    const { ipc } = setup({ meetings: { ...agreed, consentVersion: MEETINGS_CONSENT_VERSION + 1 } })
    expect(await ipc.permission(local, 'mic')).toMatchObject({ ok: false })
  })

  it('after consent: Allow microphone asks macOS once; a refusal opens System Settings', async () => {
    const { ipc } = setup({ meetings: agreed })
    expect(await ipc.permission(local, 'camera')).toMatchObject({ ok: false })
    await ipc.permission(local, 'mic')
    expect(electron.askForMediaAccess).toHaveBeenCalledWith('microphone')
    electron.getMediaAccessStatus.mockImplementation(() => 'denied')
    electron.askForMediaAccess.mockClear()
    const r = await ipc.permission(local, 'mic')
    expect(electron.askForMediaAccess).not.toHaveBeenCalled()
    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
    expect(r).toMatchObject({ ok: true, mic: 'denied' })
  })

  it("the Mac's sound on 14.2+: Allow runs the recorder's probe and stores its result", async () => {
    const { ipc, meetings, recorder } = setup({ meetings: agreed })
    expect(await ipc.permission(local, 'screen')).toMatchObject({ ok: true, screen: 'silent' })
    expect(recorder.calls).toEqual(['probe'])
    expect(meetings().systemAudio).toEqual({ at: 1000, ok: false })
    recorder.probeResult.ok = true
    expect(await ipc.permission(local, 'screen')).toMatchObject({ ok: true, screen: 'granted' })
    expect(electron.askForMediaAccess).not.toHaveBeenCalled()
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('without the recorder (none could be made) Allow for the sound opens System Settings', async () => {
    const { ipc } = setup({ meetings: agreed })
    const gate = await ipc.loadGate()
    gate.probeSystemAudio = null
    expect(await gate.permission('screen')).toMatchObject({ ok: true, screen: 'not-checked' })
    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture')
  })

  it("the Mac's sound on 13 to 14.1 is the Screen Recording grant", async () => {
    const { ipc } = setup({ meetings: agreed, version: '14.1.2' })
    electron.getMediaAccessStatus.mockImplementation((k: string) => (k === 'screen' ? 'denied' : 'granted'))
    expect(await ipc.permission(local, 'screen')).toMatchObject({ ok: true, screen: 'denied', systemAudio: 'screen' })
    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
})

describe('guardSessions', () => {
  function fakeSession() {
    let req: (wc: unknown, p: string, cb: (g: boolean) => void) => void = () => {}
    let check: (wc: unknown, p: string) => boolean = () => true
    const s: PermissionSession = {
      setPermissionRequestHandler: (h) => {
        req = h
      },
      setPermissionCheckHandler: (h) => {
        check = h
      },
    }
    const asked = (p: string) => {
      let g: boolean | null = null
      req(null, p, (v) => (g = v))
      return { request: g, check: check(null, p) }
    }
    return { s, asked }
  }

  it('the window never gets the microphone or the screen; the capture partition only while agreed; other permissions as before', () => {
    const win = fakeSession()
    const capture = fakeSession()
    const later = fakeSession()
    let created: (s: PermissionSession) => void = () => {}
    let ok = false
    const parts: string[] = []
    guardSessions(
      { on: (_e, fn) => (created = fn) },
      { defaultSession: win.s, fromPartition: (p) => (parts.push(p), capture.s) },
      () => ok,
    )
    created(later.s)
    expect(parts).toEqual(['meetings-capture'])
    for (const p of ['media', 'display-capture']) {
      expect(win.asked(p)).toEqual({ request: false, check: false })
      expect(later.asked(p)).toEqual({ request: false, check: false })
      expect(capture.asked(p)).toEqual({ request: false, check: false })
    }
    ok = true
    for (const p of ['media', 'display-capture']) {
      expect(win.asked(p)).toEqual({ request: false, check: false })
      expect(capture.asked(p)).toEqual({ request: true, check: true })
    }
    for (const p of ['notifications', 'clipboard-sanitized-write', 'fullscreen']) expect(win.asked(p)).toEqual({ request: true, check: true })
  })
})

describe('meetings:model and meetings:restart', () => {
  function withEngine(m: MeetingsSettings, over: Partial<{ platform: string; engine: string | null }> = {}) {
    let cur = m
    const calls: string[] = []
    const progress: unknown[] = []
    let restarted = 0
    class FakeStore {
      ready = (id: string) => id === 'base'
      status = () => ({ models: [{ id: 'large-v3-turbo-q5_0', ready: false }, { id: 'base', ready: true }], downloading: null })
      download = async (id: string, cb: (p: unknown) => void) => {
        calls.push(`download:${id}`)
        cb({ id, state: 'done' })
        return { ok: true }
      }
      cancel = () => (calls.push('cancel'), true)
      cleanParts = () => {}
      remove = (id: string) => (calls.push(`remove:${id}`), { ok: true })
    }
    const ipc = new MeetingsIpc({
      platform: over.platform ?? 'darwin',
      meetings: () => cur,
      setMeetings: (n) => {
        cur = n
      },
      macosVersion: () => '14.4.1',
      arch: 'arm64',
      modelsDir: '/nonexistent',
      whisper: () => ({ env: {}, resourcesPath: '', appRoot: '', packaged: true, arch: 'arm64', pathEnv: '' }),
      progress: (p) => progress.push(p),
      restart: async () => (restarted++, true),
      meetingsDir: '/nonexistent/meetings',
      capturePage: () => ({ file: '/nonexistent/capture.html' }),
      capturePreload: '/nonexistent/capture.js',
      onLive: () => {},
      notice: () => {},
      loadEngine: async () =>
        ({ ModelStore: FakeStore, findWhisper: () => ('engine' in over ? over.engine : '/acme/whisper-cli') }) as never,
    })
    return { ipc, calls, progress, meetings: () => cur, restarted: () => restarted }
  }

  it('refused from a browser and off macOS; actions are checked', async () => {
    expect(await withEngine(agreed, { platform: 'linux' }).ipc.model(local, 'status')).toEqual({ ok: false, message: MEETINGS_MAC_ONLY })
    const t = withEngine(agreed)
    expect(await t.ipc.model(remote, 'download', 'base')).toMatchObject({ ok: false })
    expect(await t.ipc.restart(remote)).toMatchObject({ ok: false })
    expect(await t.ipc.model(local, 'rm -rf')).toMatchObject({ ok: false, message: 'Not a model action.' })
    expect(await t.ipc.model(local, 'download', '../x')).toMatchObject({ ok: false, message: 'Not a speech model.' })
    expect(t.calls).toEqual([])
    expect(t.restarted()).toBe(0)
  })

  it('status: the models, the suggested one, the engine', async () => {
    const r = await withEngine(DEFAULT_MEETINGS, { engine: null }).ipc.model(local, 'status')
    expect(r).toMatchObject({ ok: true, picked: null, suggested: 'large-v3-turbo-q5_0', engine: false, downloading: null })
    if (r.ok) expect(r.models.map((m) => [m.label, m.ready])).toEqual([['Best', false], ['Fast', true]])
  })

  it('pick and download need the consent; download picks, starts and reports', async () => {
    const before = withEngine(DEFAULT_MEETINGS)
    expect(await before.ipc.model(local, 'download', 'base')).toMatchObject({ ok: false })
    expect(before.calls).toEqual([])
    const t = withEngine(agreed)
    expect(await t.ipc.model(local, 'pick', 'large-v3-turbo-q5_0')).toMatchObject({ ok: true, picked: 'large-v3-turbo-q5_0' })
    expect(await t.ipc.model(local, 'download', 'base')).toMatchObject({ ok: true, picked: 'base' })
    await vi.waitFor(() => expect(t.progress).toEqual([{ id: 'base', state: 'done' }]))
    expect(t.meetings().model).toBe('base')
    expect(await t.ipc.setup(local)).toMatchObject({ ok: true, model: { name: 'base', ready: true } })
    await t.ipc.model(local, 'cancel')
    await t.ipc.model(local, 'remove', 'base')
    expect(t.calls).toEqual(['download:base', 'cancel', 'remove:base'])
  })

  it('restart asks (deps) and is the window’s only', async () => {
    const t = withEngine(agreed)
    expect(await t.ipc.restart(local)).toEqual({ ok: true })
    expect(t.restarted()).toBe(1)
  })
})

describe('meetings:start / stop / pause', () => {
  it('refused off macOS, from a browser and before consent, without loading the recorder', async () => {
    const win = setup({ platform: 'win32', meetings: agreed })
    expect(await win.ipc.start(local)).toEqual({ ok: false, message: MEETINGS_MAC_ONLY })
    expect(win.ipc.live()).toBeNull()
    const mac = setup({ meetings: agreed })
    for (const r of [await mac.ipc.start(remote, 'x'), await mac.ipc.stop(remote), await mac.ipc.pause(remote, true)]) expect(r.ok).toBe(false)
    const before = setup()
    expect(await before.ipc.start(local)).toMatchObject({ ok: false, message: expect.stringContaining('Agree') })
    for (const t of [win, mac, before]) {
      expect(t.made()).toBe(0)
      expect(t.ipc.loaded).toBe(false)
    }
    expect(mac.ipc.live()).toEqual({ recording: false, since: null, paused: false, elapsed: 0, offer: null })
    for (const f of Object.values(electron)) expect(f).not.toHaveBeenCalled()
  })

  it('after consent: start loads the recorder once; stop and pause go to it', async () => {
    const t = setup({ meetings: agreed })
    expect(await t.ipc.stop(local)).toMatchObject({ ok: false })
    await t.ipc.start(local, 'Standup')
    await t.ipc.pause(local, true)
    await t.ipc.stop(local)
    await t.ipc.start(local)
    expect(t.made()).toBe(1)
    expect(t.recorder.calls).toEqual(['start:Standup', 'pause:true', 'stop:user', 'start:undefined'])
    expect(t.ipc.recording).toBe(false)
  })
})

describe('transcription wiring', () => {
  function withService(m: MeetingsSettings, over: Partial<{ platform: string; downloading: boolean }> = {}, extra: Partial<MeetingsDeps> = {}) {
    let cur = m
    const dir = mkdtempSync(join(tmpdir(), 'md-meetings-ipc-'))
    const calls: string[] = []
    const made: unknown[] = []
    let ready = false
    const fetch = vi.fn()
    class FakeStore {
      constructor(_dir: string, deps: unknown) {
        made.push(deps)
      }
      ready = () => ready
      path = (id: string) => `/models/${id}.bin`
      status = () => ({ models: [], downloading: over.downloading ? { id: 'base', received: 0, total: 1, state: 'downloading' } : null })
      download = async (id: string) => {
        calls.push(`download:${id}`)
        ready = true
        return { ok: true }
      }
      cancel = () => true
      remove = () => ({ ok: true })
      cleanParts = () => calls.push('cleanParts')
    }
    const transcribe = vi.fn(async () => [{ start: 0, end: 500, text: 'hello alice' }])
    const ipc = new MeetingsIpc({
      platform: over.platform ?? 'darwin',
      meetings: () => cur,
      setMeetings: (n) => {
        cur = n
      },
      macosVersion: () => '14.4.1',
      arch: 'arm64',
      modelsDir: join(dir, 'models'),
      whisper: () => ({ env: {}, resourcesPath: '', appRoot: '', packaged: true, arch: 'arm64', pathEnv: '' }),
      progress: () => {},
      restart: async () => false,
      meetingsDir: dir,
      capturePage: () => ({ file: '/nonexistent/capture.html' }),
      capturePreload: '/nonexistent/capture.js',
      onLive: () => {},
      notice: () => {},
      fetch,
      makeRecorder: async () => fakeRecorder(),
      loadEngine: async () =>
        ({ ModelStore: FakeStore, findWhisper: () => '/acme/whisper-cli', transcribe, killRunning: () => calls.push('killRunning') }) as never,
      ...extra,
    })
    return { ipc, calls, made, fetch, transcribe, dir, meetings: () => cur, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('a quit before anything was loaded loads nothing', () => {
    const t = withService(agreed)
    t.ipc.quit()
    expect(t.ipc.loaded).toBe(false)
    expect(t.calls).toEqual([])
    t.cleanup()
  })

  it('the model store gets main’s fetch and cleans its parts; a quit kills whisper-cli and stops the queue', async () => {
    const t = withService(agreed)
    const svc = await t.ipc.loadService()
    expect(t.made).toEqual([{ fetch: t.fetch }])
    expect(t.calls).toEqual(['cleanParts'])
    t.ipc.quit()
    expect(t.calls).toEqual(['cleanParts', 'killRunning'])
    // The queue was stopped: a new chunk is not transcribed.
    const m = svc.store.create({ title: '', titleBy: null, model: 'base', language: 'auto' })
    if (!m.ok) throw new Error(m.message)
    svc.store.writeChunk(m.meeting.id, 'you', 0, new Uint8Array([1]))
    svc.transcriber.add({ id: m.meeting.id, track: 'you', seq: 0 })
    await new Promise((r) => setTimeout(r, 10))
    expect(t.transcribe).not.toHaveBeenCalled()
    t.cleanup()
  })

  it('Settings → Meetings after consent loads the queue; a meeting waits for the model and goes on when its download ends', async () => {
    const t = withService(agreed)
    // Left by a crash before this start.
    const { MeetingStore } = await import('./meetings/store')
    const store = new MeetingStore(t.dir)
    const m = store.create({ title: '', titleBy: null, model: 'base', language: 'auto' })
    if (!m.ok) throw new Error(m.message)
    store.writeChunk(m.meeting.id, 'others', 0, new Uint8Array([1]))
    await t.ipc.setup(local)
    await vi.waitFor(() => expect(store.get(m.meeting.id)?.progress?.wait).toBe('Waiting for the speech model'))
    expect(store.get(m.meeting.id)?.state).toBe('transcribing')
    await t.ipc.model(local, 'download', 'base')
    await vi.waitFor(() => expect(store.get(m.meeting.id)?.state).toBe('done'))
    expect(store.get(m.meeting.id)?.segments).toEqual([{ start: 0, end: 500, speaker: 'others', text: 'hello alice' }])
    expect(t.transcribe).toHaveBeenCalledWith(expect.objectContaining({ bin: '/acme/whisper-cli', model: '/models/base.bin', language: 'auto' }))
    t.cleanup()
  })

  it('before consent, Settings → Meetings loads no queue', async () => {
    const t = withService(DEFAULT_MEETINGS)
    await t.ipc.setup(local)
    await new Promise((r) => setTimeout(r, 10))
    expect(t.calls).not.toContain('cleanParts')
    t.cleanup()
  })

  it('a download while one runs is refused before the pick is stored', async () => {
    const t = withService({ ...agreed, model: 'large-v3-turbo-q5_0' }, { downloading: true })
    expect(await t.ipc.model(local, 'download', 'base')).toMatchObject({ ok: true, message: 'A speech model is downloading already.', picked: 'large-v3-turbo-q5_0' })
    expect(t.meetings().model).toBe('large-v3-turbo-q5_0')
    expect(t.calls).not.toContain('download:base')
    t.cleanup()
  })

  it('meetings:retry: refused off macOS, from a browser, for a bad id and before consent, without loading', async () => {
    const linux = withService(agreed, { platform: 'linux' })
    expect(await linux.ipc.retry(local, 'm-' + 'a'.repeat(32))).toEqual({ ok: false, message: MEETINGS_MAC_ONLY })
    const t = withService(agreed)
    expect(await t.ipc.retry(remote, 'm-' + 'a'.repeat(32))).toMatchObject({ ok: false })
    expect(await t.ipc.retry(local, '../x')).toEqual({ ok: false, message: 'No such meeting.' })
    const before = withService(DEFAULT_MEETINGS)
    expect(await before.ipc.retry(local, 'm-' + 'a'.repeat(32))).toMatchObject({ ok: false, message: expect.stringContaining('Agree') })
    expect([...linux.calls, ...t.calls, ...before.calls]).toEqual([])
    expect(await t.ipc.retry(local, 'm-' + 'a'.repeat(32))).toEqual({ ok: false, message: 'No such meeting.' })
    for (const x of [linux, t, before]) x.cleanup()
  })

  /** Matching with a stand-in claude, the real notes store and the notices in a list. */
  async function withMatching() {
    const { NotesStore } = await import('./notes')
    const notices: MeetingNotice[] = []
    const list = {
      set: (n: MeetingNotice) => void (notices.splice(0, notices.length, ...notices.filter((x) => x.meetingId !== n.meetingId)), notices.push(n)),
      clear: (id: string, kind?: MeetingNotice['kind']) => {
        const before = notices.length
        notices.splice(0, notices.length, ...notices.filter((x) => x.meetingId !== id || (kind !== undefined && x.kind !== kind)))
        return notices.length !== before
      },
    }
    const claude = vi.fn(async (_o?: { signal?: AbortSignal }) => ({
      code: 0,
      stdout: JSON.stringify({ title: 'Hello', summary: 'Hi.', matches: [{ candidate: 'c1', segments: [[0, 0]], summary: 'Said hello.', actions: [], confidence: 'high' }] }),
      stderr: '',
    }))
    const dir = mkdtempSync(join(tmpdir(), 'md-meetings-notes-'))
    const notes = new NotesStore(dir)
    const state = { sessions: [{ key: 'k1', sessionId: 's1', name: 'alice-work', kind: 'background', bgId: 'k1', pid: 1, cwd: '/w', state: 'idle', rawState: 'idle', startedAt: 1, issue: null }], git: {}, sessionPrs: {}, prLive: {}, prs: [], issues: [], board: null } as never
    const t = withService(agreed, {}, { matching: { state: () => state, notes, claude }, notices: list })
    return { ...t, notes, notices, claude, cleanup: () => (t.cleanup(), rmSync(dir, { recursive: true, force: true })) }
  }

  it('a transcribed meeting is matched: a note about the session and a Needs-you item; a failed chunk is Try again', async () => {
    const t = await withMatching()
    const svc = await t.ipc.loadService()
    expect(svc.matcher).not.toBeNull()
    const m = svc.store.create({ title: '', titleBy: null, model: 'base', language: 'auto' })
    if (!m.ok) throw new Error(m.message)
    svc.store.writeChunk(m.meeting.id, 'you', 0, new Uint8Array([1]))
    // The model is on disk: the chunk goes now.
    await t.ipc.model(local, 'download', 'base')
    svc.transcriber.add({ id: m.meeting.id, track: 'you', seq: 0 })
    svc.store.update(m.meeting.id, (x) => ({ ...x, state: 'transcribing', ended: x.started + 1000 }))
    svc.transcriber.ended(m.meeting.id)
    await vi.waitFor(() => expect(svc.store.get(m.meeting.id)?.state).toBe('done'))
    expect(t.claude).toHaveBeenCalledTimes(1)
    expect(t.notes.meetingNotes(m.meeting.id)).toHaveLength(1)
    expect(t.notices).toEqual([expect.objectContaining({ meetingId: m.meeting.id, kind: 'added', sessions: 1, tickets: 0 })])
    // Open on its item marks it seen.
    t.ipc.seen(m.meeting.id)
    expect(t.notices).toEqual([])
    // Match again: the unedited note is replaced, not doubled.
    expect(await t.ipc.rematch(local, m.meeting.id)).toEqual({ ok: true })
    await vi.waitFor(() => expect(svc.store.get(m.meeting.id)?.state).toBe('done'))
    expect(t.notes.meetingNotes(m.meeting.id)).toHaveLength(1)

    // A chunk whisper cannot read: the meeting fails and Needs you offers Try again.
    t.transcribe.mockRejectedValueOnce(new Error('bad wav'))
    const f = svc.store.create({ title: 'Sync', titleBy: 'user', model: 'base', language: 'auto' })
    if (!f.ok) throw new Error(f.message)
    svc.store.writeChunk(f.meeting.id, 'you', 0, new Uint8Array([1]))
    svc.store.update(f.meeting.id, (x) => ({ ...x, state: 'transcribing', ended: x.started + 1000 }))
    svc.transcriber.add({ id: f.meeting.id, track: 'you', seq: 0 })
    await vi.waitFor(() => expect(svc.store.get(f.meeting.id)?.state).toBe('failed'))
    expect(t.notices.filter((n) => n.meetingId === f.meeting.id)).toEqual([expect.objectContaining({ kind: 'failed', reason: 'Transcription failed: bad wav' })])
    expect(await t.ipc.retry(local, f.meeting.id)).toEqual({ ok: true })
    expect(t.notices.filter((n) => n.kind === 'failed')).toEqual([])
    await vi.waitFor(() => expect(svc.store.get(f.meeting.id)?.state).toBe('done'))
    t.cleanup()
  })

  it('Turn off meetings stops the queue and matching now (whisper and claude killed), drops the service; the next consent picks up what is on disk', async () => {
    const t = await withMatching()
    let signal: AbortSignal | undefined
    t.claude.mockImplementationOnce(
      (o?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          signal = o?.signal
          o?.signal?.addEventListener('abort', () => resolve({ code: -4, stdout: '', stderr: 'aborted' }))
        }),
    )
    const svc = await t.ipc.loadService()
    await t.ipc.model(local, 'download', 'base')
    const m = svc.store.create({ title: '', titleBy: null, model: 'base', language: 'auto' })
    if (!m.ok) throw new Error(m.message)
    svc.store.update(m.meeting.id, (x) => ({ ...x, state: 'matching', ended: x.started + 1000, segments: [{ start: 0, end: 500, speaker: 'you', text: 'hello alice' }] }))
    void svc.matcher!.match(m.meeting.id)
    await vi.waitFor(() => expect(t.claude).toHaveBeenCalledTimes(1))

    expect(await t.ipc.consent(local, false)).toMatchObject({ ok: true, agreed: false })
    expect(signal?.aborted).toBe(true)
    expect(t.calls).toContain('killRunning')
    // The old queue takes nothing more: a chunk written now is not transcribed.
    const f = svc.store.create({ title: '', titleBy: null, model: 'base', language: 'auto' })
    if (!f.ok) throw new Error(f.message)
    svc.store.writeChunk(f.meeting.id, 'you', 0, new Uint8Array([1]))
    svc.store.update(f.meeting.id, (x) => ({ ...x, state: 'transcribing', ended: x.started + 1000 }))
    svc.transcriber.add({ id: f.meeting.id, track: 'you', seq: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(t.transcribe).not.toHaveBeenCalled()
    expect(svc.store.get(m.meeting.id)?.state).toBe('matching')
    expect(t.notes.meetingNotes(m.meeting.id)).toEqual([])
    // The page still reads the meetings (the store alone).
    expect(await t.ipc.list(local, 0, Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: true, agreed: false })

    // A new consent loads a new queue: the chunk is transcribed and the meeting left matching is matched.
    await t.ipc.consent(local, true)
    const again = await t.ipc.loadService()
    expect(again).not.toBe(svc)
    await vi.waitFor(() => expect(again.store.get(f.meeting.id)?.state).toBe('done'))
    await vi.waitFor(() => expect(again.store.get(m.meeting.id)?.state).toBe('done'))
    expect(t.transcribe).toHaveBeenCalledTimes(1)
    expect(t.notes.meetingNotes(m.meeting.id)).toHaveLength(1)
    t.cleanup()
  })

  it('a quit kills the claude -p of matching; the meeting stays matching', async () => {
    const t = await withMatching()
    let signal: AbortSignal | undefined
    t.claude.mockImplementationOnce(
      (o?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          signal = o?.signal
          o?.signal?.addEventListener('abort', () => resolve({ code: -4, stdout: '', stderr: 'aborted' }))
        }),
    )
    const svc = await t.ipc.loadService()
    const m = svc.store.create({ title: '', titleBy: null, model: 'base', language: 'auto' })
    if (!m.ok) throw new Error(m.message)
    svc.store.update(m.meeting.id, (x) => ({ ...x, state: 'matching', ended: x.started + 1000, segments: [{ start: 0, end: 500, speaker: 'you', text: 'hello alice' }] }))
    const run = svc.matcher!.match(m.meeting.id)
    await vi.waitFor(() => expect(t.claude).toHaveBeenCalledTimes(1))
    t.ipc.quit()
    expect(signal?.aborted).toBe(true)
    await run
    expect(svc.store.get(m.meeting.id)?.state).toBe('matching')
    expect(t.notices).toEqual([])
    t.cleanup()
  })

  it('matching runs tidy once when it loads', async () => {
    const tidy = vi.fn()
    const t = withService(agreed, {}, { matching: { state: () => null, notes: { addMeetingNote: vi.fn(), dropMeetingNotes: vi.fn(), meetingNotes: vi.fn(), get: vi.fn() } as never, claude: vi.fn(), tidy } })
    await t.ipc.loadService()
    await t.ipc.loadService()
    expect(tidy).toHaveBeenCalledTimes(1)
    t.cleanup()
  })

  it('Try again and a match that worked clear an old "could not match" item', async () => {
    const t = await withMatching()
    const svc = await t.ipc.loadService()
    const m = svc.store.create({ title: '', titleBy: null, model: 'base', language: 'auto' })
    if (!m.ok) throw new Error(m.message)
    svc.store.update(m.meeting.id, (x) => ({ ...x, state: 'matching', ended: x.started + 1000, segments: [{ start: 0, end: 500, speaker: 'you', text: 'hello alice' }] }))
    t.claude.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ title: '', summary: 'Hi.', matches: [] }), stderr: '' })
    t.notices.push({ meetingId: m.meeting.id, title: '', at: 1, kind: 'unmatched', reason: 'boom' })
    await svc.matcher!.match(m.meeting.id)
    expect(svc.store.get(m.meeting.id)?.state).toBe('done')
    expect(t.notices).toEqual([])
    // A failed transcription with a stale item from before: Try again clears both kinds.
    const f = svc.store.create({ title: '', titleBy: null, model: 'base', language: 'auto' })
    if (!f.ok) throw new Error(f.message)
    svc.store.writeChunk(f.meeting.id, 'you', 0, new Uint8Array([1]))
    svc.store.update(f.meeting.id, (x) => ({ ...x, state: 'failed', ended: x.started + 1000, error: 'Transcription failed: x' }))
    t.notices.push({ meetingId: f.meeting.id, title: '', at: 1, kind: 'unmatched', reason: 'old' })
    expect(await t.ipc.retry(local, f.meeting.id)).toEqual({ ok: true })
    expect(t.notices.filter((n) => n.meetingId === f.meeting.id)).toEqual([])
    t.cleanup()
  })

  it('meetings:rematch: refused off macOS, from a browser, for a bad id and before consent, without loading', async () => {
    const id = 'm-' + 'a'.repeat(32)
    const linux = withService(agreed, { platform: 'linux' })
    expect(await linux.ipc.rematch(local, id)).toEqual({ ok: false, message: MEETINGS_MAC_ONLY })
    const t = withService(agreed)
    expect(await t.ipc.rematch(remote, id)).toMatchObject({ ok: false })
    expect(await t.ipc.rematch(local, '../x')).toEqual({ ok: false, message: 'No such meeting.' })
    const before = withService(DEFAULT_MEETINGS)
    expect(await before.ipc.rematch(local, id)).toMatchObject({ ok: false, message: expect.stringContaining('Agree') })
    expect([...linux.calls, ...t.calls, ...before.calls]).toEqual([])
    // Made without matching: it says so.
    expect(await t.ipc.rematch(local, id)).toEqual({ ok: false, message: 'Matching is not set up.' })
    for (const x of [linux, t, before]) x.cleanup()
  })

  it('a load that failed is not kept: the next call loads again', async () => {
    let tries = 0
    const t = withService(agreed, {}, {
      loadService: async () => {
        if (++tries === 1) throw new Error('disk')
        return { ...(await import('./meetings/store')), ...(await import('./meetings/transcriber')) }
      },
    })
    await expect(t.ipc.loadService()).rejects.toThrow('disk')
    await expect(t.ipc.loadService()).resolves.toMatchObject({ matcher: null })
    expect(tries).toBe(2)
    t.cleanup()
  })

  it('index.ts: will-quit calls meetings.quit(); model downloads use net.fetch', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const quit = src.slice(src.indexOf('app.on("will-quit"'))
    expect(quit.slice(0, quit.indexOf('});'))).toContain('meetings.quit();')
    expect(src).toContain('fetch: (url, init) => net.fetch(url, init),')
  })
})
