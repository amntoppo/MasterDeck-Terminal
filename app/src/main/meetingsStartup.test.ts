import { readdirSync, readFileSync, statSync } from 'node:fs'
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

import { guardSessions, MeetingsIpc, type PermissionSession } from './meetingsIpc'

const MEDIA_APIS = ['askForMediaAccess', 'getUserMedia', 'getDisplayMedia', 'desktopCapturer', 'getMediaAccessStatus']

function mainSources(dir = __dirname): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return mainSources(p)
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : []
  })
}

function setup(over: Partial<{ platform: string; meetings: MeetingsSettings; version: string }> = {}) {
  let m: MeetingsSettings = over.meetings ?? DEFAULT_MEETINGS
  const ipc = new MeetingsIpc({
    platform: over.platform ?? 'darwin',
    meetings: () => m,
    setMeetings: (n) => {
      m = n
    },
    macosVersion: () => over.version ?? '14.4.1',
    now: () => 1000,
  })
  return { ipc, meetings: () => m }
}
const agreed = { ...DEFAULT_MEETINGS, consentAt: 1, consentVersion: MEETINGS_CONSENT_VERSION }
const local = {} // the window's IPC event
const remote = { remote: true }

beforeEach(() => {
  vi.clearAllMocks()
  electron.getMediaAccessStatus.mockImplementation(() => 'not-determined')
})

describe('the startup rule', () => {
  it('no main-process file outside main/meetings/ names a media API', () => {
    for (const f of mainSources()) {
      const rel = relative(__dirname, f)
      if (rel.startsWith('meetings/')) continue
      const src = readFileSync(f, 'utf8')
      for (const api of MEDIA_APIS) expect(src.includes(api), `${rel} names ${api}`).toBe(false)
    }
  })

  it('main/meetings/ is never imported statically; one dynamic import, in meetingsIpc.ts', () => {
    const dynamic: string[] = []
    for (const f of mainSources()) {
      const rel = relative(__dirname, f)
      if (rel.startsWith('meetings/')) continue
      const src = readFileSync(f, 'utf8')
      for (const line of src.split('\n')) {
        if (/^\s*import\s+(?!type\b).*from\s+["']\.\/meetings\//.test(line)) throw new Error(`${rel} imports main/meetings/ at load: ${line}`)
        if (/(?<!typeof )\bimport\(\s*["']\.\/meetings\//.test(line)) dynamic.push(rel)
      }
    }
    expect(dynamic).toEqual(['meetingsIpc.ts'])
  })

  it('index.ts guards the sessions and wires the handlers without loading the gate', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(src).toContain('guardSessions(app, session,')
    for (const ch of ['meetingsSetup', 'meetingsConsent', 'meetingsPermission']) expect(src).toMatch(new RegExp(`reg\\.handle\\(CH\\.${ch},`))
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

  it("the Mac's sound on 14.2+: System Settings until the probe exists, then the probe's result is stored", async () => {
    const { ipc, meetings } = setup({ meetings: agreed })
    expect(await ipc.permission(local, 'screen')).toMatchObject({ ok: true, screen: 'not-checked' })
    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture')
    const gate = await ipc.loadGate()
    gate.probeSystemAudio = async () => false
    expect(await ipc.permission(local, 'screen')).toMatchObject({ ok: true, screen: 'silent' })
    expect(meetings().systemAudio).toEqual({ at: 1000, ok: false })
    gate.probeSystemAudio = async () => true
    expect(await ipc.permission(local, 'screen')).toMatchObject({ ok: true, screen: 'granted' })
    expect(electron.askForMediaAccess).not.toHaveBeenCalled()
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
