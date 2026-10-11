import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wav } from '@shared/meetingAudio'
import { CAPTURE_CH, MEETING_MAX_MS, recordedMs } from '@shared/meetings'

// Electron is a fake: no window opens, nothing is captured, macOS is asked nothing.
const fake = vi.hoisted(() => {
  type Handler = (...a: unknown[]) => void
  const ipc = new Map<string, Handler>()
  const wins: FakeWin[] = []
  const state = { hold: null as Promise<void> | null, mic: 'granted', displayHandler: null as null | ((req: unknown, cb: (s: unknown) => void) => void), handlerOpts: null as unknown }
  class FakeWin {
    opts: Record<string, unknown>
    destroyed = false
    private on_: Record<string, Handler[]> = {}
    scripts: string[] = []
    loaded: string | null = null
    webContents = {
      mainFrame: { processId: 7, routingId: wins.length + 1 },
      executeJavaScript: async (code: string, gesture?: boolean) => {
        this.scripts.push(`${code}${gesture ? ' [gesture]' : ''}`)
      },
      setWindowOpenHandler: () => {},
      on: (ev: string, fn: Handler) => ((this.on_[`wc:${ev}`] ??= []).push(fn), undefined),
    }
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      wins.push(this)
    }
    on(ev: string, fn: Handler) {
      ;(this.on_[ev] ??= []).push(fn)
    }
    emit(ev: string, ...a: unknown[]) {
      for (const f of this.on_[ev] ?? []) f(...a)
    }
    async loadURL(u: string) {
      this.loaded = u
    }
    async loadFile(f: string) {
      // A page that is still loading (state.hold): no script reaches it yet.
      await state.hold
      this.loaded = f
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  return { ipc, wins, state, FakeWin }
})
vi.mock('electron', () => ({
  BrowserWindow: fake.FakeWin,
  ipcMain: { on: (ch: string, fn: (...a: unknown[]) => void) => fake.ipc.set(ch, fn) },
  session: {
    fromPartition: () => ({
      setDisplayMediaRequestHandler: (h: never, opts: unknown) => {
        fake.state.displayHandler = h
        fake.state.handlerOpts = opts
      },
    }),
  },
  systemPreferences: { getMediaAccessStatus: () => fake.state.mic },
}))

import { MeetingStore } from './store'
import { Recorder, type RecorderDeps } from './recorder'

let dir: string
let clock: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-rec-'))
  clock = 10_000
  fake.ipc.clear()
  fake.wins.length = 0
  fake.state.mic = 'granted'
  fake.state.hold = null
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function setup(over: Partial<RecorderDeps> = {}) {
  const store = new MeetingStore(dir, () => clock)
  const notices: string[] = []
  let changes = 0
  let agreed = true
  const chunks: string[] = []
  const rec = new Recorder({
    store,
    agreed: () => agreed,
    model: () => 'base',
    language: () => 'auto',
    modelReady: () => true,
    page: { file: '/acme/capture.html' },
    preload: '/acme/capture.js',
    onChange: () => changes++,
    notice: (t) => notices.push(t),
    onChunk: (c) => chunks.push(`${c.track}-${c.seq}`),
    now: () => clock,
    stopWaitMs: 50,
    probeWaitMs: 50,
    ...over,
  })
  const win = () => fake.wins[fake.wins.length - 1]
  const ev = (w = win()) => ({ sender: w.webContents, senderFrame: { ...w.webContents.mainFrame } })
  const send = (ch: string, e: unknown, ...a: unknown[]) => fake.ipc.get(ch)!(e, ...a)
  return { rec, store, notices, chunks, changes: () => changes, win, ev, send, disagree: () => (agreed = false) }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Recorder', () => {
  it('start opens one hidden, sandboxed capture window on its partition and starts it with a gesture', async () => {
    const t = setup()
    const r = await t.rec.start('  Planning ')
    expect(r).toMatchObject({ ok: true, live: { recording: true, paused: false, since: 10_000 } })
    expect(r.ok && r.message).toBeFalsy()
    const w = t.win()
    expect(w.opts).toMatchObject({ show: false, webPreferences: { partition: 'meetings-capture', preload: '/acme/capture.js', contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    await flush()
    expect(w.loaded).toBe('/acme/capture.html')
    const id = r.ok ? r.id! : ''
    expect(w.scripts).toEqual([`window.mdCapture.record("${id}") [gesture]`])
    expect(t.store.get(id)).toMatchObject({ title: 'Planning', titleBy: 'user', state: 'recording', model: 'base' })
    expect(await t.rec.start()).toMatchObject({ ok: false, message: 'A meeting is being recorded already.' })
    expect(fake.wins.length).toBe(1)
    expect(t.rec.recording).toBe(true)
  })

  it('refuses without consent, without the microphone grant, or with a bad title; nothing is made', async () => {
    const t = setup()
    fake.state.mic = 'not-determined'
    expect(await t.rec.start()).toMatchObject({ ok: false })
    fake.state.mic = 'granted'
    expect(await t.rec.start('a\nb')).toMatchObject({ ok: false })
    t.disagree()
    expect(await t.rec.start()).toMatchObject({ ok: false })
    expect(fake.wins.length).toBe(0)
    expect(t.store.list()).toEqual([])
  })

  it('recording without a speech model is allowed and says the transcript waits', async () => {
    const t = setup({ modelReady: () => false })
    expect(await t.rec.start()).toMatchObject({ ok: true, message: expect.stringContaining('speech model') })
  })

  it('the display-media handler answers only the capture window, only while agreed, with loopback', async () => {
    const t = setup()
    expect(fake.state.handlerOpts).toEqual({ useSystemPicker: false })
    const answer = (frame: unknown) => {
      let got: unknown = 'none'
      fake.state.displayHandler!({ frame }, (s) => (got = s))
      return got
    }
    expect(answer({ processId: 7, routingId: 1 })).toEqual({})
    await t.rec.start()
    const frame = { ...t.win().webContents.mainFrame }
    expect(answer(frame)).toEqual({ video: frame, audio: 'loopback' })
    expect(answer({ processId: 7, routingId: 99 })).toEqual({})
    expect(answer(null)).toEqual({})
    t.disagree()
    expect(answer(frame)).toEqual({})
  })

  it('chunks: only from the capture window, its id, a track, a new sequence number, a real WAV', async () => {
    const t = setup()
    const r = await t.rec.start()
    const id = r.ok ? r.id! : ''
    const good = wav(new Int16Array(16))
    const other = new fake.FakeWin({})
    t.send(CAPTURE_CH.chunk, { sender: other.webContents, senderFrame: other.webContents.mainFrame }, { id, track: 'you', seq: 0 }, good)
    t.send(CAPTURE_CH.chunk, { sender: fake.wins[0].webContents, senderFrame: { processId: 7, routingId: 42 } }, { id, track: 'you', seq: 0 }, good)
    t.send(CAPTURE_CH.chunk, t.ev(fake.wins[0]), { id: 'm-' + 'b'.repeat(32), track: 'you', seq: 0 }, good)
    t.send(CAPTURE_CH.chunk, t.ev(fake.wins[0]), { id, track: '../x', seq: 0 }, good)
    t.send(CAPTURE_CH.chunk, t.ev(fake.wins[0]), { id, track: 'you', seq: 0.5 }, good)
    t.send(CAPTURE_CH.chunk, t.ev(fake.wins[0]), { id, track: 'you', seq: 0 }, new Uint8Array(100))
    t.send(CAPTURE_CH.chunk, t.ev(fake.wins[0]), { id, track: 'you', seq: 0 }, new Uint8Array(2 * 1024 * 1024))
    expect(t.store.leftovers()).toEqual([])
    t.send(CAPTURE_CH.chunk, t.ev(fake.wins[0]), { id, track: 'you', seq: 0 }, good)
    t.send(CAPTURE_CH.chunk, t.ev(fake.wins[0]), { id, track: 'you', seq: 0 }, good) // again: refused
    t.send(CAPTURE_CH.chunk, t.ev(fake.wins[0]), { id, track: 'others', seq: 0 }, good.buffer)
    expect(t.chunks).toEqual(['you-0', 'others-0'])
    expect(readFileSync(t.store.chunkPath(id, 'you', 0)!)).toEqual(Buffer.from(good))
  })

  it('audio slices are appended from the capture window only, at most 1 MB each', async () => {
    const t = setup()
    const r = await t.rec.start()
    const id = r.ok ? r.id! : ''
    t.send(CAPTURE_CH.audio, t.ev(), id, new Uint8Array([1, 2]))
    t.send(CAPTURE_CH.audio, t.ev(), id, new Uint8Array(1024 * 1024 + 1))
    t.send(CAPTURE_CH.audio, t.ev(), 'm-' + 'c'.repeat(32), new Uint8Array([9]))
    t.send(CAPTURE_CH.audio, { sender: {}, senderFrame: null }, id, new Uint8Array([9]))
    t.send(CAPTURE_CH.audio, t.ev(), id, new Uint8Array([3]))
    expect([...readFileSync(t.store.audioPath(id)!)]).toEqual([1, 2, 3])
  })

  it('pause and resume leave the paused time out; stop waits for the window, then hands over to transcription', async () => {
    const t = setup()
    const r = await t.rec.start()
    const id = r.ok ? r.id! : ''
    // The page is loaded and started (a pause before that: the next test).
    await flush()
    t.send(CAPTURE_CH.chunk, t.ev(), { id, track: 'you', seq: 0 }, wav(new Int16Array(4)))
    clock += 5000
    expect(await t.rec.pause(true)).toMatchObject({ ok: true, live: { paused: true, elapsed: 5000 } })
    clock += 60_000
    expect(t.rec.live()).toMatchObject({ paused: true, elapsed: 5000 })
    expect(await t.rec.pause('yes')).toMatchObject({ ok: false })
    await t.rec.pause(false)
    clock += 1000
    // The state stays the same while it runs (elapsed as of the resume); the rail counts from since.
    expect(t.rec.live()).toMatchObject({ paused: false, since: 70_000, elapsed: 5000 })
    expect(recordedMs(t.rec.live(), clock)).toBe(6000)
    await flush()
    expect(t.win().scripts.slice(1)).toEqual(['window.mdCapture.command("pause")', 'window.mdCapture.command("resume")'])
    const w = t.win()
    const stopped = t.rec.stop()
    await flush()
    expect(w.scripts.at(-1)).toBe('window.mdCapture.command("stop")')
    t.send(CAPTURE_CH.chunk, t.ev(w), { id, track: 'you', seq: 1 }, wav(new Int16Array(4)))
    t.send(CAPTURE_CH.ended, t.ev(w), 'stopped')
    expect(await stopped).toMatchObject({ ok: true, live: { recording: false } })
    expect(w.destroyed).toBe(true)
    expect(t.store.get(id)).toMatchObject({ state: 'transcribing', ended: clock, pausedMs: 60_000, error: null })
    expect(t.chunks).toEqual(['you-0', 'you-1'])
    expect(t.notices).toEqual([])
    expect(await t.rec.stop()).toMatchObject({ ok: false })
  })

  it('a pause pressed while the page loads goes in with the start; later commands go as before', async () => {
    let loaded = () => {}
    fake.state.hold = new Promise<void>((res) => (loaded = res))
    const t = setup()
    const r = await t.rec.start()
    const id = r.ok ? r.id! : ''
    expect(await t.rec.pause(true)).toMatchObject({ ok: true, live: { paused: true } })
    await flush()
    // Nothing was sent to a page that is not there.
    expect(t.win().scripts).toEqual([])
    loaded()
    await flush()
    expect(t.win().scripts).toEqual([`window.mdCapture.command("pause");window.mdCapture.record("${id}") [gesture]`])
    await t.rec.pause(false)
    await flush()
    expect(t.win().scripts.at(-1)).toBe('window.mdCapture.command("resume")')
  })

  it('a Stop pressed while the page loads goes in with the start; the page ends at once', async () => {
    let loaded = () => {}
    fake.state.hold = new Promise<void>((res) => (loaded = res))
    const t = setup()
    const r = await t.rec.start()
    const id = r.ok ? r.id! : ''
    const w = t.win()
    await t.rec.pause(true)
    const stopped = t.rec.stop()
    await flush()
    expect(w.scripts).toEqual([])
    loaded()
    await flush()
    expect(w.scripts).toEqual([`window.mdCapture.command("stop");window.mdCapture.record("${id}") [gesture]`])
    t.send(CAPTURE_CH.ended, t.ev(w), 'stopped')
    expect(await stopped).toMatchObject({ ok: true, live: { recording: false } })
    expect(t.store.get(id)).toMatchObject({ state: 'failed', error: 'Nothing was recorded.' })
  })

  it('the mic gate goes to a started page like a pause; a repeat sends nothing; the last value is kept', async () => {
    const t = setup()
    const r = await t.rec.start()
    const id = r.ok ? r.id! : ''
    await flush()
    t.rec.setMicGate(true)
    t.rec.setMicGate(true)
    expect(t.rec.micGated).toBe(true)
    t.rec.setMicGate(false)
    await flush()
    expect(t.win().scripts).toEqual([`window.mdCapture.record("${id}") [gesture]`, 'window.mdCapture.command("gate")', 'window.mdCapture.command("ungate")'])
    expect(t.rec.micGated).toBe(false)
  })

  it('a gate set while the page loads (or before Record) goes in with the start: a muted start never keeps the mic', async () => {
    let loaded = () => {}
    fake.state.hold = new Promise<void>((res) => (loaded = res))
    const t = setup()
    const r = await t.rec.start()
    const id = r.ok ? r.id! : ''
    t.rec.setMicGate(true)
    await t.rec.pause(true)
    await flush()
    expect(t.win().scripts).toEqual([])
    loaded()
    await flush()
    expect(t.win().scripts).toEqual([`window.mdCapture.command("gate");window.mdCapture.command("pause");window.mdCapture.record("${id}") [gesture]`])
    const w = t.win()
    const stopped = t.rec.stop()
    await flush()
    t.send(CAPTURE_CH.ended, t.ev(w), 'stopped')
    await stopped
    // Set before the next Record: its start script carries it.
    fake.state.hold = null
    const r2 = await t.rec.start()
    await flush()
    expect(t.win().scripts).toEqual([`window.mdCapture.command("gate");window.mdCapture.record("${r2.ok ? r2.id : ''}") [gesture]`])
  })

  it('a window that never answers Stop is closed anyway', async () => {
    const t = setup()
    const r = await t.rec.start()
    t.send(CAPTURE_CH.chunk, t.ev(), { id: r.ok ? r.id : '', track: 'you', seq: 0 }, wav(new Int16Array(4)))
    expect(await t.rec.stop()).toMatchObject({ ok: true })
    expect(t.win().destroyed).toBe(true)
    expect(t.store.get(r.ok ? r.id : '')).toMatchObject({ state: 'transcribing' })
  })

  it('a refused microphone fails the meeting with a reason and a notice', async () => {
    const t = setup()
    const r = await t.rec.start()
    t.send(CAPTURE_CH.ended, t.ev(), 'mic-refused')
    await flush()
    expect(t.rec.recording).toBe(false)
    expect(t.store.get(r.ok ? r.id : '')).toMatchObject({ state: 'failed', error: expect.stringContaining('microphone') })
    expect(t.notices).toHaveLength(1)
  })

  it('a crashed capture window ends the recording; what it wrote is kept', async () => {
    const t = setup()
    const r = await t.rec.start()
    const id = r.ok ? r.id! : ''
    t.send(CAPTURE_CH.chunk, t.ev(), { id, track: 'you', seq: 0 }, wav(new Int16Array(4)))
    t.win().emit('closed')
    await flush()
    expect(t.rec.recording).toBe(false)
    expect(t.store.get(id)).toMatchObject({ state: 'transcribing', error: expect.any(String) })
    expect(existsSync(t.store.chunkPath(id, 'you', 0)!)).toBe(true)
  })

  it('stops by itself at 4 hours, with a notice', async () => {
    vi.useFakeTimers()
    const t = setup({ stopWaitMs: 10 })
    const r = await t.rec.start()
    t.send(CAPTURE_CH.chunk, t.ev(), { id: r.ok ? r.id : '', track: 'you', seq: 0 }, wav(new Int16Array(4)))
    clock += MEETING_MAX_MS
    await vi.advanceTimersByTimeAsync(10_050)
    expect(t.rec.recording).toBe(false)
    expect(t.notices[0]).toMatch(/4 hours/)
    expect(t.store.get(r.ok ? r.id : '')).toMatchObject({ state: 'transcribing', error: 'The recording stopped at 4 hours.' })
  })

  it('probe: true only for a live, non-silent track; one at a time; never during consent off', async () => {
    const t = setup()
    const p = t.rec.probe()
    expect(t.rec.probe()).toBe(p)
    expect(await t.rec.start()).toMatchObject({ ok: false })
    await flush()
    expect(t.win().scripts).toEqual(['window.mdCapture.probe() [gesture]'])
    t.send(CAPTURE_CH.level, t.ev(), 'others', 0.02)
    t.send(CAPTURE_CH.ended, t.ev(), 'probe')
    expect(await p).toBe(true)
    expect(t.win().destroyed).toBe(true)

    const silent = t.rec.probe()
    await flush()
    t.send(CAPTURE_CH.level, t.ev(), 'others', 0)
    t.send(CAPTURE_CH.ended, t.ev(), 'probe')
    expect(await silent).toBe(false)

    const missing = t.rec.probe()
    await flush()
    t.send(CAPTURE_CH.level, t.ev(), 'others', 0.5)
    t.send(CAPTURE_CH.ended, t.ev(), 'no-track')
    expect(await missing).toBe(false)

    // No answer at all: false after the wait.
    expect(await t.rec.probe()).toBe(false)
    t.disagree()
    const n = fake.wins.length
    expect(await t.rec.probe()).toBe(false)
    expect(fake.wins.length).toBe(n)
  })
})
