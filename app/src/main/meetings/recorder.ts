import { BrowserWindow, ipcMain, session, systemPreferences, type IpcMainEvent } from 'electron'
import { checkWav } from '@shared/meetingAudio'
import {
  asCaptureEnd,
  AUDIO_SLICE_MAX_BYTES,
  CAPTURE_CH,
  CAPTURE_PARTITION,
  cleanTitle,
  IDLE_LIVE,
  MEETING_MAX_MS,
  PROBE_SILENCE,
  recordedMs,
  TRACKS,
  type CaptureCommand,
  type CaptureEnd,
  type MeetingLive,
  type RecordAnswer,
  type Speaker,
} from '@shared/meetings'
import type { MeetingStore } from './store'

export interface RecorderDeps {
  store: MeetingStore
  /** The consent holds (checked at Record, at the probe, and in the display-media handler). */
  agreed(): boolean
  /** The speech model and language a new meeting is transcribed with. */
  model(): string | null
  language(): string
  /** Whether that model is on disk (else the recording says the transcript waits). */
  modelReady(): boolean
  /** The capture page: the dev server's URL or the built file. */
  page: { url: string } | { file: string }
  /** The capture window's own preload (out/preload/capture.js). */
  preload: string
  /** The recording started, paused, resumed or stopped: AppState.meetingLive changed. */
  onChange(): void
  /** Something the user must hear about (a recording stopped by itself). */
  notice(text: string): void
  /** A chunk is on disk (the transcription queue, a later step, takes it from here). */
  onChunk?(c: { id: string; track: Speaker; seq: number }): void
  /** A recording ended; the meeting is no longer `recording`. */
  onEnded?(id: string): void
  now?: () => number
  /** How long Stop waits for the window's last chunks before closing it. */
  stopWaitMs?: number
  probeWaitMs?: number
}

interface Recording {
  id: string
  started: number
  pausedAt: number | null
  /** When it last started running (the start, or the last resume): live() stays the same while it runs. */
  resumedAt: number
  pausedMs: number
  /** The last sequence number written per track (-1: none yet). */
  last: Record<Speaker, number>
  chunks: number
  /** The loudest the others' track was (the probe's answer while recording). */
  othersMax: number
  error: string | null
  ended: (reason: CaptureEnd) => void
  done: Promise<CaptureEnd>
  timer: NodeJS.Timeout
  stopping: Promise<void> | null
}

const ENDED_TEXT: Partial<Record<CaptureEnd, string>> = {
  'mic-refused': 'The microphone could not be opened. Allow it on Settings → Meetings.',
  'mic-ended': 'The microphone went away (unplugged or taken by another app).',
  error: 'The recording stopped because of an error.',
}

/** The same frame: WebFrameMain wrappers are compared by what names the frame, not by object. */
const sameFrame = (a: { processId: number; routingId: number } | null | undefined, b: { processId: number; routingId: number } | null | undefined): boolean =>
  !!a && !!b && a.processId === b.processId && a.routingId === b.routingId

const bytesOf = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null

/**
 * The hidden capture window and its chunks (spec §2). One recording at a time, or one probe.
 * Loaded only after consent and a press of Record or Allow (main/meetingsIpc.ts imports it
 * dynamically). Every message from the window is checked: its sender is the capture window's own
 * main frame, its id the recording's, its track one of two, its sequence number new, its bytes a
 * 16 kHz mono WAV of at most 1 MB (an audio slice: at most 1 MB).
 */
export class Recorder {
  private win: BrowserWindow | null = null
  private rec: Recording | null = null
  private probing: { promise: Promise<boolean>; max: number; ended: (r: CaptureEnd) => void } | null = null
  private now: () => number

  constructor(private d: RecorderDeps) {
    this.now = d.now ?? Date.now
    // Only our window, only while the consent holds; the video is the window's own blank frame
    // (dropped by the page at once), the audio the Mac's (OPERATIONS § Meetings: capture).
    session.fromPartition(CAPTURE_PARTITION).setDisplayMediaRequestHandler(
      (request, callback) => {
        const w = this.win
        if (!w || w.isDestroyed() || !sameFrame(request.frame, w.webContents.mainFrame) || !this.d.agreed()) return callback({})
        callback({ video: request.frame!, audio: 'loopback' })
      },
      { useSystemPicker: false },
    )
    ipcMain.on(CAPTURE_CH.chunk, (e, meta: unknown, bytes: unknown) => this.chunk(e, meta, bytes))
    ipcMain.on(CAPTURE_CH.audio, (e, id: unknown, bytes: unknown) => this.audio(e, id, bytes))
    ipcMain.on(CAPTURE_CH.level, (e, track: unknown, value: unknown) => this.level(e, track, value))
    ipcMain.on(CAPTURE_CH.ended, (e, reason: unknown) => {
      if (!this.fromCapture(e)) return
      const r = asCaptureEnd(reason)
      this.rec?.ended(r)
      this.probing?.ended(r)
    })
  }

  get recording(): boolean {
    return this.rec !== null
  }

  live(): MeetingLive {
    const r = this.rec
    if (!r) return IDLE_LIVE
    const since = r.started + r.pausedMs
    // elapsed is as of the last change, so the state does not change every second (the rail counts).
    return { recording: true, since, paused: r.pausedAt !== null, elapsed: Math.max(0, (r.pausedAt ?? r.resumedAt) - since), offer: null }
  }

  private fromCapture(e: IpcMainEvent): boolean {
    const w = this.win
    return !!w && !w.isDestroyed() && e.sender === w.webContents && sameFrame(e.senderFrame, w.webContents.mainFrame)
  }

  /** The hidden window: its own partition and preload, sandboxed, never throttled, never navigating. */
  private open(onGone: () => void): BrowserWindow {
    const w = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      title: 'MasterDeck capture',
      webPreferences: {
        partition: CAPTURE_PARTITION,
        preload: this.d.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.webContents.on('will-navigate', (e) => e.preventDefault())
    w.webContents.on('render-process-gone', onGone)
    w.on('closed', () => {
      if (this.win === w) this.win = null
      onGone()
    })
    this.win = w
    return w
  }

  /** Load the page, then start it with a user gesture (getDisplayMedia wants one). */
  private async run(w: BrowserWindow, call: string): Promise<void> {
    const p = this.d.page
    await ('url' in p ? w.loadURL(p.url) : w.loadFile(p.file))
    if (!w.isDestroyed()) await w.webContents.executeJavaScript(call, true)
  }

  private close(): void {
    const w = this.win
    this.win = null
    if (w && !w.isDestroyed()) w.destroy()
  }

  async start(rawTitle?: unknown): Promise<RecordAnswer> {
    if (this.rec) return { ok: false, message: 'A meeting is being recorded already.' }
    if (this.probing) return { ok: false, message: "MasterDeck is checking the Mac's sound; try again in a moment." }
    if (!this.d.agreed()) return { ok: false, message: 'Agree to how meetings work first (Settings → Meetings).' }
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted')
      return { ok: false, message: 'Allow the microphone on Settings → Meetings first.' }
    const title = cleanTitle(rawTitle)
    if (title === null) return { ok: false, message: 'A title is one line of at most 120 characters.' }
    const made = this.d.store.create({ title, titleBy: title ? 'user' : null, model: this.d.model(), language: this.d.language() })
    if (!made.ok) return made
    const id = made.meeting.id
    let ended: (r: CaptureEnd) => void = () => {}
    const done = new Promise<CaptureEnd>((res) => (ended = res))
    const rec: Recording = {
      id,
      started: made.meeting.started,
      pausedAt: null,
      resumedAt: made.meeting.started,
      pausedMs: 0,
      last: { you: -1, others: -1 },
      chunks: 0,
      othersMax: 0,
      error: null,
      ended: (r) => ended(r),
      done,
      timer: setInterval(() => {
        if (this.rec === rec && recordedMs(this.live(), this.now()) >= MEETING_MAX_MS) void this.stop('limit')
      }, 10_000),
      stopping: null,
    }
    this.rec = rec
    // A window that ends by itself (an unplugged microphone, a crash) finishes the meeting.
    void done.then((reason) => {
      if (this.rec === rec && !rec.stopping) void this.finish(rec, reason)
    })
    const w = this.open(() => rec.ended('error'))
    this.d.onChange()
    // The id is MEETING_ID (hex): nothing of the user's reaches this script.
    this.run(w, `window.mdCapture.record(${JSON.stringify(id)})`).catch(() => rec.ended('error'))
    return {
      ok: true,
      id,
      live: this.live(),
      ...(this.d.modelReady() ? {} : { message: 'Recording. The transcript waits until a speech model is downloaded (Settings → Meetings).' }),
    }
  }

  private command(c: CaptureCommand): void {
    const w = this.win
    if (w && !w.isDestroyed()) void w.webContents.executeJavaScript(`window.mdCapture.command(${JSON.stringify(c)})`).catch(() => {})
  }

  async pause(paused: unknown): Promise<RecordAnswer> {
    const r = this.rec
    if (typeof paused !== 'boolean') return { ok: false, message: 'Not a pause.' }
    if (!r || r.stopping) return { ok: false, message: 'Nothing is being recorded.' }
    if (paused && r.pausedAt === null) {
      r.pausedAt = this.now()
      this.command('pause')
    } else if (!paused && r.pausedAt !== null) {
      r.resumedAt = this.now()
      r.pausedMs += r.resumedAt - r.pausedAt
      r.pausedAt = null
      this.command('resume')
    }
    this.d.onChange()
    return { ok: true, live: this.live() }
  }

  /** Stop: the window sends its last chunks and the last audio slice, then closes. */
  async stop(why: 'user' | 'limit' | 'disk' | 'quit' = 'user'): Promise<RecordAnswer> {
    const r = this.rec
    if (!r) return { ok: false, message: 'Nothing is being recorded.' }
    if (!r.stopping) {
      r.stopping = (async () => {
        this.command('stop')
        const wait = new Promise<CaptureEnd>((res) => setTimeout(() => res('error'), this.d.stopWaitMs ?? 10_000))
        const reason = await Promise.race([r.done, wait])
        await this.finish(r, reason === 'stopped' ? 'stopped' : reason, why)
      })()
    }
    await r.stopping
    return { ok: true, live: this.live() }
  }

  /** The meeting goes on to transcription (or fails when nothing was recorded); the window closes. */
  private async finish(r: Recording, reason: CaptureEnd, why: 'user' | 'limit' | 'disk' | 'quit' = 'user'): Promise<void> {
    if (this.rec !== r) return
    clearInterval(r.timer)
    const now = this.now()
    const pausedMs = r.pausedMs + (r.pausedAt !== null ? now - r.pausedAt : 0)
    const problem = reason === 'stopped' ? null : (ENDED_TEXT[reason] ?? ENDED_TEXT.error!)
    const error = r.error ?? (why === 'limit' ? 'The recording stopped at 4 hours.' : problem)
    const nothing = r.chunks === 0
    this.d.store.update(r.id, (m) => ({
      ...m,
      ended: now,
      pausedMs,
      state: nothing ? 'failed' : 'transcribing',
      error: nothing ? (error ?? 'Nothing was recorded.') : error,
    }))
    this.rec = null
    this.close()
    this.d.onChange()
    this.d.onEnded?.(r.id)
    if (why === 'limit') this.d.notice('The recording stopped at 4 hours. The transcript follows.')
    else if (r.error) this.d.notice(`The recording stopped: ${r.error}`)
    else if (problem && why !== 'quit') this.d.notice(problem)
  }

  private chunk(e: IpcMainEvent, meta: unknown, raw: unknown): void {
    const r = this.rec
    if (!r || !this.fromCapture(e)) return
    const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null
    const bytes = bytesOf(raw)
    if (!m || m.id !== r.id || !TRACKS.includes(m.track as Speaker) || typeof m.seq !== 'number' || !Number.isInteger(m.seq)) return
    const track = m.track as Speaker
    // Each sequence number once, in order; a WAV exactly as the window writes it.
    if (m.seq <= r.last[track] || !bytes || !checkWav(bytes)) return
    const w = this.d.store.writeChunk(r.id, track, m.seq, bytes)
    if (!w.ok) {
      r.error = w.message
      void this.stop('disk')
      return
    }
    r.last[track] = m.seq
    r.chunks++
    this.d.onChunk?.({ id: r.id, track, seq: m.seq })
  }

  private audio(e: IpcMainEvent, id: unknown, raw: unknown): void {
    const r = this.rec
    if (!r || !this.fromCapture(e) || id !== r.id) return
    const bytes = bytesOf(raw)
    if (!bytes || !bytes.length || bytes.length > AUDIO_SLICE_MAX_BYTES) return
    // ponytail: a failed append (a full disk, the size cap) loses the playback copy from there on;
    // the chunks (the transcript) go on, and a full disk stops them too. Upgrade: a second file.
    const a = this.d.store.appendAudio(r.id, bytes)
    if (!a.ok && !r.error) console.error(`meetings: audio not written: ${a.message}`)
  }

  private level(e: IpcMainEvent, track: unknown, value: unknown): void {
    if (!this.fromCapture(e) || track !== 'others' || typeof value !== 'number' || !Number.isFinite(value) || value > 1) return
    if (this.rec) this.rec.othersMax = Math.max(this.rec.othersMax, value)
    if (this.probing) this.probing.max = Math.max(this.probing.max, value)
  }

  /**
   * One second of the Mac's sound (Settings → Meetings' Allow): true when the track was live and
   * not silent. The first capture is what brings up macOS's prompt. During a recording: whether
   * the others' track has come through so far.
   */
  probe(): Promise<boolean> {
    if (this.rec) return Promise.resolve(this.rec.othersMax > PROBE_SILENCE)
    if (this.probing) return this.probing.promise
    if (!this.d.agreed()) return Promise.resolve(false)
    let ended: (r: CaptureEnd) => void = () => {}
    const done = new Promise<CaptureEnd>((res) => (ended = res))
    const p: { promise: Promise<boolean>; max: number; ended: (r: CaptureEnd) => void } = { promise: Promise.resolve(false), max: 0, ended: (r) => ended(r) }
    p.promise = (async () => {
      const w = this.open(() => p.ended('error'))
      this.run(w, 'window.mdCapture.probe()').catch(() => p.ended('error'))
      // The wait covers macOS's prompt, which the first capture brings up.
      const wait = new Promise<CaptureEnd>((res) => setTimeout(() => res('error'), this.d.probeWaitMs ?? 60_000))
      const reason = await Promise.race([done, wait])
      return reason === 'probe' && p.max > PROBE_SILENCE
    })().finally(() => {
      if (this.probing === p) this.probing = null
      this.close()
    })
    this.probing = p
    return p.promise
  }
}
