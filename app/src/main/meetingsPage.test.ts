import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MEETINGS, MEETINGS_CONSENT_VERSION, MEETINGS_MAC_ONLY, type MeetingsSettings } from '@shared/meetings'

// Nothing here may ask macOS anything: every Electron API is a spy.
vi.mock('electron', () => ({
  systemPreferences: { askForMediaAccess: vi.fn(), getMediaAccessStatus: vi.fn(() => 'not-determined') },
  desktopCapturer: { getSources: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

import { MeetingsIpc, type MeetingsDeps } from './meetingsIpc'
import { MeetingStore } from './meetings/store'
import { copyMeetingsFixture } from './meetingsFixture'

const agreed: MeetingsSettings = { ...DEFAULT_MEETINGS, consentAt: 1, consentVersion: MEETINGS_CONSENT_VERSION }
const local = {}
const remote = { remote: true }
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function page(m: MeetingsSettings = agreed, over: Partial<MeetingsDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'md-meetings-page-'))
  dirs.push(dir)
  const changed: (string | null)[] = []
  const asked: string[] = []
  const cleared: string[] = []
  let answer = true
  let savePath: string | null = join(dir, 'out.md')
  const transcribe = vi.fn(async () => [])
  const ipc = new MeetingsIpc({
    platform: 'darwin',
    meetings: () => m,
    setMeetings: () => {},
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
    loadEngine: async () =>
      ({
        ModelStore: class {
          ready = () => false
          path = () => ''
          status = () => ({ models: [], downloading: null })
          cleanParts = () => {}
        },
        findWhisper: () => null,
        transcribe,
        killRunning: () => {},
      }) as never,
    notices: { set: () => {}, clear: (id) => (cleared.push(id), true) },
    changed: (id) => changed.push(id),
    confirm: async (o) => (asked.push(o.message), answer),
    saveFile: async () => savePath,
    ...over,
  })
  const store = new MeetingStore(dir)
  const make = (title: string, started: number) => {
    const r = store.create({ title, titleBy: 'user', model: null, language: 'auto' })
    if (!r.ok) throw new Error(r.message)
    store.update(r.meeting.id, (x) => ({ ...x, started, ended: started + 60_000, state: 'done', segments: [{ start: 0, end: 500, speaker: 'others', text: 'hello alice' }] }))
    return r.meeting.id
  }
  return {
    ipc,
    dir,
    store,
    make,
    changed,
    asked,
    cleared,
    transcribe,
    answer: (a: boolean) => (answer = a),
    save: (p: string | null) => (savePath = p),
  }
}

describe('meetings:list', () => {
  it('the meetings that started in [from, to), newest first, without transcripts', async () => {
    const p = page()
    const a = p.make('A', 1000)
    const b = p.make('B', 2000)
    p.make('C', 3000)
    const r = await p.ipc.list(local, 1000, 3000)
    if (!r.ok) throw new Error(r.message)
    expect(r.meetings.map((m) => m.id)).toEqual([b, a])
    expect(r.meetings[0]).not.toHaveProperty('segments')
    expect(r.agreed).toBe(true)
    expect((await p.ipc.list(local, 0, 999)).ok && (await p.ipc.list(local, 0, 999))).toMatchObject({ meetings: [] })
  })

  it('refuses a bad range, a browser and any OS but macOS', async () => {
    const p = page()
    for (const [f, t] of [
      [3, 1],
      [-1, 5],
      [Number.NaN, 5],
      ['0', 5],
    ] as [unknown, unknown][])
      expect(await p.ipc.list(local, f, t)).toEqual({ ok: false, message: 'Not a range.' })
    expect((await p.ipc.list(remote, 0, 1)).ok).toBe(false)
    const win = page(agreed, { platform: 'win32' })
    expect(await win.ipc.list(local, 0, 1)).toEqual({ ok: false, message: MEETINGS_MAC_ONLY })
  })

  it('without consent (after Turn off meetings) the stored meetings are listed, and nothing is transcribed', async () => {
    const p = page(DEFAULT_MEETINGS)
    const id = p.make('A', 1000)
    p.store.writeChunk(id, 'you', 0, new Uint8Array([1]))
    p.store.update(id, (x) => ({ ...x, state: 'transcribing' }))
    const r = await p.ipc.list(local, 0, 10_000)
    expect(r.ok && r.meetings.map((m) => m.id)).toEqual([id])
    expect(r.ok && r.agreed).toBe(false)
    await new Promise((res) => setTimeout(res, 20))
    expect(p.transcribe).not.toHaveBeenCalled()
    expect(p.store.get(id)?.progress).toBeNull()
  })
})

describe('meetings:get / rename', () => {
  it('get gives the transcript and whether there is audio, and marks its item seen', async () => {
    const p = page()
    const id = p.make('A', 1000)
    let r = await p.ipc.get(local, id)
    expect(r.ok && r.meeting.segments).toHaveLength(1)
    expect(r.ok && r.audio).toBe(false)
    expect(p.cleared).toContain(id)
    p.store.appendAudio(id, new Uint8Array([1, 2]))
    r = await p.ipc.get(local, id)
    expect(r.ok && r.audio).toBe(true)
    expect(await p.ipc.get(local, '../x')).toEqual({ ok: false, message: 'No such meeting.' })
    expect(await p.ipc.get(local, 'm-' + 'f'.repeat(32))).toEqual({ ok: false, message: 'No such meeting.' })
    expect((await p.ipc.get(remote, id)).ok).toBe(false)
  })

  it('rename stores a clean title by the user; a bad one is refused', async () => {
    const p = page()
    const id = p.make('A', 1000)
    expect(await p.ipc.rename(local, id, '  Acme sync  ')).toEqual({ ok: true })
    expect(p.store.get(id)).toMatchObject({ title: 'Acme sync', titleBy: 'user' })
    expect(p.changed).toContain(id)
    expect(await p.ipc.rename(local, id, 'a\nb')).toEqual({ ok: false, message: 'Not a title.' })
    expect(await p.ipc.rename(local, id, 'x'.repeat(500))).toEqual({ ok: false, message: 'Not a title.' })
    expect(await p.ipc.rename(local, id, 42)).toEqual({ ok: false, message: 'Not a title.' })
    expect((await p.ipc.rename(remote, id, 'x')).ok).toBe(false)
  })
})

describe('meetings:delete / deleteAudio', () => {
  it('delete asks first; No keeps it; Yes drops file, audio and chunks, forgets it in the queue, clears its item', async () => {
    const p = page()
    const id = p.make('Standup', 1000)
    p.store.appendAudio(id, new Uint8Array([1]))
    const svc = await p.ipc.loadService()
    const forget = vi.spyOn(svc.transcriber, 'forget')
    p.answer(false)
    expect(await p.ipc.delete(local, id)).toEqual({ ok: false, message: 'cancelled' })
    expect(p.store.get(id)).not.toBeNull()
    expect(forget).not.toHaveBeenCalled()
    p.answer(true)
    expect(await p.ipc.delete(local, id)).toEqual({ ok: true })
    expect(p.asked[0]).toBe('Delete the meeting “Standup”?')
    expect(forget).toHaveBeenCalledWith(id)
    expect(p.store.get(id)).toBeNull()
    expect(existsSync(join(p.dir, id))).toBe(false)
    expect(existsSync(join(p.dir, `${id}.json`))).toBe(false)
    expect(p.cleared).toContain(id)
    expect(p.changed).toContain(id)
  })

  it('delete without consent works (nothing was loaded to forget); from a browser never', async () => {
    const p = page(DEFAULT_MEETINGS)
    const id = p.make('A', 1000)
    expect((await p.ipc.delete(remote, id)).ok).toBe(false)
    expect(p.asked).toEqual([])
    expect(await p.ipc.delete(local, id)).toEqual({ ok: true })
    expect(p.store.get(id)).toBeNull()
  })

  it('delete audio asks, keeps the transcript', async () => {
    const p = page()
    const id = p.make('A', 1000)
    p.store.appendAudio(id, new Uint8Array([1]))
    expect(await p.ipc.deleteAudio(local, id)).toEqual({ ok: true })
    expect(existsSync(join(p.dir, id, 'audio.webm'))).toBe(false)
    expect(p.store.get(id)?.segments).toHaveLength(1)
    expect(p.asked).toEqual(['Delete the audio of “A”?'])
  })

  it('a meeting being recorded is neither deleted nor loses its audio', async () => {
    const p = page(agreed, {
      makeRecorder: async () =>
        ({ recording: true, meetingId: null, live: () => ({}), start: async () => ({}), stop: async () => ({}), pause: async () => ({}), probe: async () => true }) as never,
    })
    const id = p.make('A', 1000)
    const rec = await p.ipc.loadRecorder()
    ;(rec as { meetingId: string | null }).meetingId = id
    expect(await p.ipc.delete(local, id)).toEqual({ ok: false, message: 'Stop the recording first.' })
    expect(await p.ipc.deleteAudio(local, id)).toEqual({ ok: false, message: 'Stop the recording first.' })
    expect(p.asked).toEqual([])
  })
})

describe('meetings:export', () => {
  it('Markdown to the picked file; audio as a copy; a cancel writes nothing', async () => {
    const p = page()
    const id = p.make('Acme', 1000)
    expect(await p.ipc.export(local, id, 'md')).toEqual({ ok: true })
    expect(readFileSync(join(p.dir, 'out.md'), 'utf8')).toContain('**Others** 0:00  hello alice')
    expect(await p.ipc.export(local, id, 'audio')).toEqual({ ok: false, message: 'This meeting has no audio.' })
    p.store.appendAudio(id, new Uint8Array([7, 8, 9]))
    p.save(join(p.dir, 'out.webm'))
    expect(await p.ipc.export(local, id, 'audio')).toEqual({ ok: true })
    expect([...readFileSync(join(p.dir, 'out.webm'))]).toEqual([7, 8, 9])
    p.save(null)
    expect(await p.ipc.export(local, id, 'md')).toEqual({ ok: false, message: 'cancelled' })
    expect(await p.ipc.export(local, id, 'pdf')).toEqual({ ok: false, message: 'Not an export.' })
    expect((await p.ipc.export(remote, id, 'md')).ok).toBe(false)
  })
})

describe('the media scheme’s file', () => {
  it('the store’s audio.webm of a meeting it holds, in a real folder; else none', async () => {
    const p = page()
    const id = p.make('A', 1000)
    expect(await p.ipc.audioFile(id)).toBeNull()
    p.store.appendAudio(id, new Uint8Array([1]))
    expect(await p.ipc.audioFile(id)).toBe(join(p.dir, id, 'audio.webm'))
    expect(await p.ipc.audioFile('../' + id)).toBeNull()
    // A folder named like a meeting with no meeting file: not the store's.
    const ghost = 'm-' + 'e'.repeat(32)
    mkdirSync(join(p.dir, ghost))
    writeFileSync(join(p.dir, ghost, 'audio.webm'), 'x')
    expect(await p.ipc.audioFile(ghost)).toBeNull()
    expect(await page(agreed, { platform: 'linux' }).ipc.audioFile(id)).toBeNull()
  })

  it('a meeting folder that is a link elsewhere is not served', async () => {
    const p = page()
    const id = p.make('A', 1000)
    const other = mkdtempSync(join(tmpdir(), 'md-meetings-other-'))
    dirs.push(other)
    writeFileSync(join(other, 'audio.webm'), 'secret')
    rmSync(join(p.dir, id), { recursive: true })
    symlinkSync(other, join(p.dir, id))
    expect(await p.ipc.audioFile(id)).toBeNull()
  })
})

describe('the isolated app’s fixture', () => {
  const fixture = join(__dirname, '../../test/fixtures/meetings')

  it('copies the meeting, its audio and its note, only with MASTERDECK_ISOLATED=1, never over a file', () => {
    const home = mkdtempSync(join(tmpdir(), 'md-meetings-fixture-'))
    dirs.push(home)
    expect(copyMeetingsFixture({ MASTERDECK_MEETINGS_FIXTURE: fixture }, home)).toBeNull()
    expect(existsSync(join(home, 'meetings'))).toBe(false)
    const id = copyMeetingsFixture({ MASTERDECK_MEETINGS_FIXTURE: fixture, MASTERDECK_ISOLATED: '1' }, home)!
    const store = new MeetingStore(join(home, 'meetings'))
    expect(store.get(id)?.title).toBe('Acme web standup')
    expect(readFileSync(join(home, 'meetings', id, 'audio.webm')).length).toBeGreaterThan(1000)
    expect(readFileSync(join(home, 'meetings', id, 'audio.webm')).length).toBeLessThan(50 * 1024)
    expect(existsSync(join(home, 'notes', 'n-ac3e0000000000000000000000000a01.json'))).toBe(true)
    store.update(id, (m) => ({ ...m, title: 'Renamed' }))
    copyMeetingsFixture({ MASTERDECK_MEETINGS_FIXTURE: fixture, MASTERDECK_ISOLATED: '1' }, home)
    expect(store.get(id)?.title).toBe('Renamed')
  })
})
