import { copyFileSync, existsSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import {
  CAPTURE_PARTITION,
  cleanTitle,
  IDLE_LIVE,
  MEETING_ID,
  MEETINGS_CONSENT_VERSION,
  MEETINGS_MAC_ONLY,
  mediaAllowed,
  meetingsAgreed,
  type MeetingLive,
  type MeetingNotice,
  type MeetingsAnswer,
  type MeetingsSettings,
  type RecordAnswer,
} from '@shared/meetings'
import { defaultModel, MODEL_OPS, MODELS, modelById, type ModelOp, type ModelProgress, type ModelsAnswer } from '@shared/meetingModels'
import { MATCH_FAILED } from '@shared/meetingMatch'
import {
  EXPORT_KINDS,
  exportName,
  meetingMarkdown,
  meetingRow,
  type ExportKind,
  type MeetingGetAnswer,
  type MeetingsListAnswer,
  type MeetingsResult,
} from '@shared/meetingsPage'
import { AUDIO_SWEEP_EVERY_MS, AUDIO_SWEEP_FIRST_MS, audioExpired, cleanRequest, janitorRows, type MeetingsCleanAnswer, type MeetingsJanitorAnswer } from '@shared/meetingJanitor'
import type { AppState } from '@shared/types'
import { isRemote } from './ipcRegistry'
import type { NotesStore } from './notes'
import type { RunResult } from './run'
// Types only: erased from the build, so this file never loads main/meetings/ by itself.
import type { MeetingsGate } from './meetings/gate'
import type { ModelStore, ModelStoreDeps } from './meetings/models'
import type { WhisperWhere } from './meetings/whisper'
import type { Recorder } from './meetings/recorder'
import type { MeetingStore } from './meetings/store'
import type { Transcriber } from './meetings/transcriber'
import type { Matcher } from './meetings/matcher'

type GateModule = typeof import('./meetings/gate')
type EngineModule = typeof import('./meetings/models') & typeof import('./meetings/whisper')
type RecorderModule = typeof import('./meetings/recorder')
type ServiceModule = typeof import('./meetings/store') & typeof import('./meetings/transcriber') & Partial<typeof import('./meetings/matcher')>
/** The part of the recorder MeetingsIpc uses (tests pass a fake). */
export type RecorderLike = Pick<Recorder, 'start' | 'stop' | 'pause' | 'probe' | 'live' | 'recording' | 'meetingId'>
/** The meetings on disk and the transcription queue, loaded together after consent. */
export interface MeetingsService {
  store: MeetingStore
  transcriber: Transcriber
  /** Null when MeetingsIpc was made without `matching` (the meeting is done once it is text). */
  matcher: Matcher | null
}

/** What matching needs from the rest of main (spec §4): the state, the notes, one claude -p. */
export interface MatchingDeps {
  /** The latest AppState once the session list was read; null before. */
  state(): AppState | null
  notes: Pick<NotesStore, 'addMeetingNote' | 'dropMeetingNotes' | 'meetingNotes' | 'get'>
  claude(o: { model: string; prompt: string; timeoutMs: number }): Promise<RunResult>
}

/** The meetings' Needs-you items (main/meetingNotices.ts). */
export interface NoticesLike {
  set(n: MeetingNotice): void
  clear(meetingId: string, kind?: MeetingNotice['kind']): boolean
}

export interface MeetingsDeps {
  platform: string
  /** Settings → Meetings as stored now. */
  meetings(): MeetingsSettings
  /** Store Settings → Meetings (the whole settings file, atomically). */
  setMeetings(m: MeetingsSettings): void
  /** process.getSystemVersion(); read only when the gate loads. */
  macosVersion(): string
  now?: () => number
  /** How main/meetings/gate.ts is loaded (tests count it); default a dynamic import. */
  load?: () => Promise<GateModule>
  /** process.arch: the default model and the bundled whisper-cli's folder. */
  arch: string
  /** MASTERDECK_HOME/meetings/models */
  modelsDir: string
  /** Where whisper-cli may be (read on each status, so a PATH found later counts). */
  whisper(): WhisperWhere
  /** A model download's progress, to the window only. */
  progress(p: ModelProgress): void
  /** Restart MasterDeck after asking the user; false when they said no. */
  restart(): Promise<boolean>
  /** How main/meetings/models.ts and whisper.ts are loaded (tests pass a fake fetch through it). */
  loadEngine?: () => Promise<EngineModule>
  /** The model downloads' fetch (main passes Electron's net.fetch: the system's proxy); default the global fetch. */
  fetch?: ModelStoreDeps['fetch']
  /** How main/meetings/store.ts and transcriber.ts are loaded; default a dynamic import. */
  loadService?: () => Promise<ServiceModule>
  /** MASTERDECK_HOME/meetings */
  meetingsDir: string
  /** The capture window's page (dev server URL or built file) and its preload. */
  capturePage: () => { url: string } | { file: string }
  capturePreload: string
  /** The recording started, paused or stopped (AppState.meetingLive is read again). */
  onLive(): void
  /** A recording stopped by itself: tell the user (a macOS notification). */
  notice(text: string): void
  /** How the recorder is made (tests pass a fake; default: main/meetings/recorder.ts and store.ts, loaded now). */
  makeRecorder?: (o: { gate: MeetingsGate; engine: ModelStore; service: MeetingsService }) => Promise<RecorderLike>
  /** A meeting is all text and `matching`: this takes it instead of the matcher (tests). */
  onTranscribed?: (id: string) => void
  /** Matching and its notes; unset (and no onTranscribed): a meeting is done once it is text. */
  matching?: MatchingDeps
  /** Needs you: notes added, matching or transcription failed. */
  notices?: NoticesLike
  /** A meeting changed (or, null, the list): the Meetings page reads it again. To the window only. */
  changed?(id: string | null): void
  /** Ask in the window (a native dialog): true when the user pressed `button`. */
  confirm?(o: { message: string; detail: string; button: string }): Promise<boolean>
  /** A save dialog for an export: the path picked, or null. */
  saveFile?(o: { defaultName: string; kind: ExportKind }): Promise<string | null>
}

/** The page's list holds at most this many meetings of a range (newest first). */
const LIST_MAX = 500

const isFileAt = (p: string): boolean => {
  try {
    return lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** Write a file the user picked atomically: a temp file next to it, then a rename. */
function writeExport(path: string, write: (tmp: string) => void): MeetingsResult {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    write(tmp)
    renameSync(tmp, path)
    return { ok: true }
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    const code = (e as { code?: string })?.code
    return { ok: false, message: code === 'ENOSPC' ? 'The disk is full.' : code === 'EACCES' || code === 'EPERM' ? 'MasterDeck may not write there.' : 'Could not save the file.' }
  }
}

/**
 * The meetings:* handlers' logic (main/index.ts registers them). Spec §1: nothing here runs at
 * startup, and main/meetings/ is loaded only the first time Settings → Meetings asks for its state
 * or after consent. Every call from a browser, and every call off macOS, is refused.
 */
export class MeetingsIpc {
  private gate: Promise<MeetingsGate> | null = null
  private engine: Promise<{ store: ModelStore; mod: EngineModule }> | null = null
  /** The engine module once loaded (a quit stops its whisper-cli runs without waiting). */
  private engineMod: EngineModule | null = null
  private service: Promise<MeetingsService> | null = null
  private svc: MeetingsService | null = null
  private recorder: Promise<RecorderLike> | null = null
  /** The recorder once loaded (live() and the quit check read it without waiting). */
  private rec: RecorderLike | null = null
  /** The meetings on disk alone (the page without consent): no queue, nothing transcribed. */
  private bare: Promise<MeetingStore> | null = null
  constructor(private d: MeetingsDeps) {}

  /** A load that failed is not kept: the next call loads again (a full disk now is not one for ever). */
  private once<T>(p: Promise<T>, clear: () => void): Promise<T> {
    p.catch(() => clear())
    return p
  }

  /** Whether main/meetings/ was loaded (the startup test). */
  get loaded(): boolean {
    return this.gate !== null
  }

  private refused(e: unknown): { ok: false; message: string } | null {
    if (this.d.platform !== 'darwin') return { ok: false, message: MEETINGS_MAC_ONLY }
    if (isRemote(e)) return { ok: false, message: 'Meetings are set up in MasterDeck on the Mac.' }
    return null
  }

  /** The gate, loaded once. The recorder fills its probeSystemAudio. */
  loadGate(): Promise<MeetingsGate> {
    const load = this.d.load ?? (() => import('./meetings/gate'))
    this.gate ??= load().then(
      (m) =>
        new m.MeetingsGate({
          meetings: () => this.d.meetings(),
          saveSystemAudio: (systemAudio) => this.d.setMeetings({ ...this.d.meetings(), systemAudio }),
          macosVersion: this.d.macosVersion(),
          now: this.d.now,
        }),
    )
    return this.gate
  }

  /** The model store and whisper finder, loaded once (with the gate: never at startup). */
  loadEngine(): Promise<{ store: ModelStore; mod: EngineModule }> {
    const load = this.d.loadEngine ?? (async () => ({ ...(await import('./meetings/models')), ...(await import('./meetings/whisper')) }))
    this.engine ??= this.once(
      load().then((mod) => {
        const store = new mod.ModelStore(this.d.modelsDir, this.d.fetch ? { fetch: this.d.fetch } : {})
        // What a quit or a crash in the middle of a download left (nothing downloads yet).
        store.cleanParts()
        this.engineMod = mod
        return { mod, store }
      }),
      () => (this.engine = null),
    )
    return this.engine
  }

  /**
   * The meetings on disk and the transcription queue, loaded once, only after consent (the first
   * Record, Settings → Meetings, Try again). Loading it finishes what a crash or a quit left: the
   * chunks on disk are queued first.
   */
  loadService(): Promise<MeetingsService> {
    this.service ??= this.once(this.makeService(), () => (this.service = null))
    return this.service
  }

  private async makeService(): Promise<MeetingsService> {
    const { store: models, mod: engine } = await this.loadEngine()
    const load =
      this.d.loadService ??
      (async () => ({ ...(await import('./meetings/store')), ...(await import('./meetings/transcriber')), ...(await import('./meetings/matcher')) }))
    const mod = await load()
    const store = new mod.MeetingStore(this.d.meetingsDir)
    const m = this.d.matching
    const matcher =
      m && mod.Matcher
        ? new mod.Matcher({
            store,
            notes: m.notes,
            state: () => m.state(),
            claude: (o) => m.claude(o),
            notice: (n) => this.d.notices?.set(n),
            onChange: (id) => this.d.changed?.(id),
            now: this.d.now,
          })
        : null
    const onTranscribed = this.d.onTranscribed ?? (matcher ? (id: string) => void matcher.match(id) : undefined)
    const transcriber = new mod.Transcriber({
      store,
      // The model the meeting was recorded with, else the one picked now: the first on disk.
      modelPath: (x) => {
        for (const name of [x.model, this.d.meetings().model]) if (name && models.ready(name)) return models.path(name)
        return null
      },
      engine: () => engine.findWhisper(this.d.whisper()),
      transcribe: (o) => engine.transcribe(o),
      live: () => this.rec?.meetingId ?? null,
      onTranscribed,
      onChange: (id) => {
        this.noticeOf(store, id)
        this.d.changed?.(id)
      },
      now: this.d.now,
    })
    this.svc = { store, transcriber, matcher }
    transcriber.start()
    return this.svc
  }

  /** A transcription that failed is a Needs-you item (Try again); once it goes on, the item goes. */
  private noticeOf(store: MeetingStore, id: string): void {
    const n = this.d.notices
    if (!n) return
    const m = store.get(id)
    if (!m) return void n.clear(id)
    if (m.state === 'failed' && m.error && !m.error.startsWith(MATCH_FAILED))
      n.set({ meetingId: id, title: m.title, at: (this.d.now ?? Date.now)(), kind: 'failed', reason: m.error })
    else if (m.state !== 'failed') n.clear(id, 'failed')
  }

  /** Load the service in the background when the consent holds (errors only logged). */
  private warmService(): void {
    if (!meetingsAgreed({ meetings: this.d.meetings() })) return
    this.loadService().catch((err) => console.error(`meetings: could not load: ${String(err)}`))
  }

  /**
   * The recorder (main/meetings/recorder.ts), loaded once, after consent, at the first Record or
   * the first Allow of the Mac's sound; it fills the gate's probeSystemAudio.
   */
  loadRecorder(): Promise<RecorderLike> {
    this.recorder ??= this.once(this.makeRecorder(), () => (this.recorder = null))
    return this.recorder
  }

  private makeRecorder(): Promise<RecorderLike> {
    return Promise.all([this.loadGate(), this.loadEngine(), this.loadService()]).then(async ([gate, { store: engine }, service]) => {
      const make =
        this.d.makeRecorder ??
        (async () => {
          const mod: RecorderModule = await import('./meetings/recorder')
          return new mod.Recorder({
            store: service.store,
            agreed: () => meetingsAgreed({ meetings: this.d.meetings() }),
            model: () => this.d.meetings().model,
            language: () => this.d.meetings().language,
            modelReady: () => {
              const m = this.d.meetings().model
              return !!m && engine.ready(m)
            },
            page: this.d.capturePage(),
            preload: this.d.capturePreload,
            onChange: () => {
              this.d.onLive()
              this.d.changed?.(null)
            },
            notice: (t) => this.d.notice(t),
            // Each chunk is transcribed as it closes; the end finishes the meeting.
            onChunk: (c) => service.transcriber.add(c),
            onEnded: (id) => service.transcriber.ended(id),
            now: this.d.now,
          })
        })
      const rec = await make({ gate, engine, service })
      gate.probeSystemAudio = () => rec.probe()
      this.rec = rec
      return rec
    })
  }

  /** AppState.meetingLive: null off macOS; idle until the recorder was ever loaded. */
  live(): MeetingLive | null {
    if (this.d.platform !== 'darwin') return null
    return this.rec?.live() ?? IDLE_LIVE
  }

  /** Whether a meeting is being recorded now (quitting asks first). */
  get recording(): boolean {
    return this.rec?.recording ?? false
  }

  /** Record (the rail, ⌘K). Recording without a speech model is allowed: the transcript waits, and the answer says so. */
  async start(e: unknown, title?: unknown): Promise<RecordAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (!meetingsAgreed({ meetings: this.d.meetings() })) return { ok: false, message: 'Agree to how meetings work first (Settings → Meetings).' }
    return (await this.loadRecorder()).start(title)
  }

  async stop(e: unknown): Promise<RecordAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (!this.rec) return { ok: false, message: 'Nothing is being recorded.' }
    return this.rec.stop()
  }

  async pause(e: unknown, paused: unknown): Promise<RecordAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (!this.rec) return { ok: false, message: 'Nothing is being recorded.' }
    return this.rec.pause(paused)
  }

  /** Quitting while recording (after the user said yes): the last chunks are written first. */
  async stopForQuit(): Promise<void> {
    if (this.rec?.recording) await this.rec.stop('quit')
  }

  /**
   * will-quit: the queue starts nothing more and every whisper-cli still running is killed (its
   * chunk stays for the next start). Only what was loaded: a quit never loads main/meetings/.
   */
  quit(): void {
    this.stopBackground()
    this.svc?.transcriber.stop()
    this.svc?.matcher?.stop()
    this.engineMod?.killRunning()
  }

  /** Try again on a meeting whose transcription failed (the Meetings page, Needs you). The window only. */
  async retry(e: unknown, id: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    const r = this.refused(e)
    if (r) return r
    if (typeof id !== 'string' || !MEETING_ID.test(id)) return { ok: false, message: 'No such meeting.' }
    if (!meetingsAgreed({ meetings: this.d.meetings() })) return { ok: false, message: 'Agree to how meetings work first (Settings → Meetings).' }
    const res = (await this.loadService()).transcriber.retry(id)
    if (res.ok) this.d.notices?.clear(id, 'failed')
    return res
  }

  /**
   * Match again (the Meetings page, Needs you; the window only): this meeting's notes the user never
   * edited are removed, then it is matched as if it had just been transcribed.
   */
  async rematch(e: unknown, id: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    const r = this.refused(e)
    if (r) return r
    if (typeof id !== 'string' || !MEETING_ID.test(id)) return { ok: false, message: 'No such meeting.' }
    if (!meetingsAgreed({ meetings: this.d.meetings() })) return { ok: false, message: 'Agree to how meetings work first (Settings → Meetings).' }
    const svc = await this.loadService()
    if (!svc.matcher) return { ok: false, message: 'Matching is not set up.' }
    const res = svc.matcher.rematch(id)
    if (res.ok) this.d.notices?.clear(id)
    return res
  }

  // ── The Meetings page (spec §6) ────────────────────────────────────────────

  /**
   * The store the page reads. With the consent it is the service's (loading it, so what a quit or
   * a crash left is transcribed now, as the quit dialog promises). Without it (never agreed, or
   * after Turn off meetings) the stored meetings can still be read, exported and deleted, but
   * nothing is queued, transcribed or recorded: the store alone is loaded.
   */
  private async pageStore(): Promise<MeetingStore> {
    if (this.svc) return this.svc.store
    if (meetingsAgreed({ meetings: this.d.meetings() })) return (await this.loadService()).store
    return this.bareStore()
  }

  /** The meetings on disk alone: no queue, nothing transcribed. */
  private bareStore(): Promise<MeetingStore> {
    this.bare ??= this.once(
      (async () => {
        const load = this.d.loadService ?? (async () => ({ ...(await import('./meetings/store')), ...(await import('./meetings/transcriber')) }))
        return new (await load()).MeetingStore(this.d.meetingsDir)
      })(),
      () => (this.bare = null),
    )
    return this.bare
  }

  /** The meeting a page call names, or a refusal. */
  private async pageMeeting(e: unknown, id: unknown) {
    const r = this.refused(e)
    if (r) return r
    if (typeof id !== 'string' || !MEETING_ID.test(id)) return { ok: false as const, message: 'No such meeting.' }
    const store = await this.pageStore()
    const m = store.get(id)
    return m ? { ok: true as const, store, m } : { ok: false as const, message: 'No such meeting.' }
  }

  /** The meetings that started in [from, to), newest first, without their transcripts. */
  async list(e: unknown, from: unknown, to: unknown): Promise<MeetingsListAnswer> {
    const r = this.refused(e)
    if (r) return r
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
    if (!ok(from) || !ok(to) || to < from) return { ok: false, message: 'Not a range.' }
    // ponytail: every meeting file is read for each list (fine for hundreds); upgrade: an index file.
    const meetings = (await this.pageStore()).list(from, to).slice(0, LIST_MAX).map(meetingRow)
    return { ok: true, meetings, agreed: meetingsAgreed({ meetings: this.d.meetings() }) }
  }

  /** One meeting with its transcript; opening it resolves its "notes added" item in Needs you. */
  async get(e: unknown, id: unknown): Promise<MeetingGetAnswer> {
    const x = await this.pageMeeting(e, id)
    if (!x.ok) return x
    this.seen(x.m.id)
    const audio = x.store.audioPath(x.m.id)
    return { ok: true, meeting: x.m, audio: !!audio && isFileAt(audio) }
  }

  /** Whether this meeting is the one being recorded now. */
  private recordingNow(id: string): boolean {
    return !!this.rec?.recording && this.rec.meetingId === id
  }

  /** A title the user typed ('' leaves it unnamed). */
  async rename(e: unknown, id: unknown, title: unknown): Promise<MeetingsResult> {
    const t = cleanTitle(title)
    if (t === null) return { ok: false, message: 'Not a title.' }
    const x = await this.pageMeeting(e, id)
    if (!x.ok) return x
    const u = x.store.update(x.m.id, (m) => ({ ...m, title: t, titleBy: t ? 'user' : null }))
    if (!u.ok) return u
    this.d.changed?.(x.m.id)
    return { ok: true }
  }

  /**
   * Delete a meeting after a native question: its file, audio and chunks; nothing of it stays
   * queued. The notes it added stay (they are the user's notes now; the question says so).
   */
  async delete(e: unknown, id: unknown): Promise<MeetingsResult> {
    const x = await this.pageMeeting(e, id)
    if (!x.ok) return x
    if (this.recordingNow(x.m.id)) return { ok: false, message: 'Stop the recording first.' }
    const yes = await this.d.confirm?.({
      message: x.m.title ? `Delete the meeting “${x.m.title}”?` : 'Delete this meeting?',
      detail: 'Its transcript and audio are removed. The notes it added stay: they are your notes now.',
      button: 'Delete meeting',
    })
    if (!yes) return { ok: false, message: 'cancelled' }
    if (this.recordingNow(x.m.id)) return { ok: false, message: 'Stop the recording first.' }
    return this.dropMeeting(x.store, x.m.id)
  }

  /** The one way a meeting goes (the page, Janitor): out of the queue, off disk, its item gone. Its notes stay. */
  private dropMeeting(store: MeetingStore, id: string): MeetingsResult {
    this.svc?.transcriber.forget(id)
    const res = store.delete(id)
    if (!res.ok) return res
    this.d.notices?.clear(id)
    this.d.changed?.(id)
    return { ok: true }
  }

  /** The one way a meeting's audio goes (the page, Janitor, the timer); the transcript and notes stay. */
  private dropAudio(store: MeetingStore, id: string): MeetingsResult {
    const res = store.deleteAudio(id)
    if (!res.ok) return res
    this.d.changed?.(id)
    return { ok: true }
  }

  /** Delete a meeting's audio after a native question; the transcript and notes stay. */
  async deleteAudio(e: unknown, id: unknown): Promise<MeetingsResult> {
    const x = await this.pageMeeting(e, id)
    if (!x.ok) return x
    if (this.recordingNow(x.m.id)) return { ok: false, message: 'Stop the recording first.' }
    const yes = await this.d.confirm?.({
      message: x.m.title ? `Delete the audio of “${x.m.title}”?` : 'Delete the audio of this meeting?',
      detail: 'The transcript and the notes it added stay.',
      button: 'Delete audio',
    })
    if (!yes) return { ok: false, message: 'cancelled' }
    if (this.recordingNow(x.m.id)) return { ok: false, message: 'Stop the recording first.' }
    return this.dropAudio(x.store, x.m.id)
  }

  /** Export the transcript as Markdown or the audio as .webm, to a file the user picks in a save dialog. */
  async export(e: unknown, id: unknown, kind: unknown): Promise<MeetingsResult> {
    if (!EXPORT_KINDS.includes(kind as ExportKind)) return { ok: false, message: 'Not an export.' }
    const x = await this.pageMeeting(e, id)
    if (!x.ok) return x
    const k = kind as ExportKind
    const audio = x.store.audioPath(x.m.id)
    if (k === 'audio' && (!audio || !isFileAt(audio))) return { ok: false, message: 'This meeting has no audio.' }
    const path = await this.d.saveFile?.({ defaultName: exportName(x.m, k), kind: k })
    if (!path) return { ok: false, message: 'cancelled' }
    return k === 'md' ? writeExport(path, (tmp) => writeFileSync(tmp, meetingMarkdown(x.m))) : writeExport(path, (tmp) => copyFileSync(audio!, tmp))
  }

  // ── Janitor → Meetings (spec §7) ───────────────────────────────────────────

  /** Every meeting with its audio's and transcript's size (the one being recorded marked). */
  async janitor(e: unknown): Promise<MeetingsJanitorAnswer> {
    const r = this.refused(e)
    if (r) return r
    const store = await this.pageStore()
    return { ok: true, rows: janitorRows(store.sizes(), this.rec?.recording ? this.rec.meetingId : null) }
  }

  /**
   * Janitor's Delete audio / Delete meetings on the picked meetings, after a native question (as the
   * page's deletes; over 10 the window had the count typed first). The meeting being recorded is
   * skipped; a meeting goes the page's way (dropMeeting) and its notes stay.
   */
  async clean(e: unknown, raw: unknown): Promise<MeetingsCleanAnswer> {
    const r = this.refused(e)
    if (r) return r
    const req = cleanRequest(raw)
    if (!req) return { ok: false, message: 'Not a cleanup.' }
    const store = await this.pageStore()
    const can = (id: string) => !this.recordingNow(id) && !!store.get(id)
    const n = req.ids.filter(can).length
    if (n === 0) return { ok: true, done: 0, skipped: req.ids.length }
    const many = n === 1 ? 'this meeting' : `${n} meetings`
    const yes = await this.d.confirm?.(
      req.what === 'audio'
        ? { message: `Delete the audio of ${many}?`, detail: 'The transcripts and the notes they added stay.', button: 'Delete audio' }
        : {
            message: n === 1 ? 'Delete this meeting?' : `Delete ${n} meetings?`,
            detail: 'Their transcripts and audio are removed. The notes they added stay: they are your notes now.',
            button: n === 1 ? 'Delete meeting' : 'Delete meetings',
          },
    )
    if (!yes) return { ok: false, message: 'cancelled' }
    let done = 0
    let skipped = 0
    let message: string | undefined
    for (const id of req.ids) {
      // Checked again: one may have gone while the question was open.
      if (!can(id)) {
        skipped++
        continue
      }
      const res = req.what === 'audio' ? this.dropAudio(store, id) : this.dropMeeting(store, id)
      if (res.ok) done++
      else {
        skipped++
        message ??= res.message
      }
    }
    if (done) this.d.changed?.(null)
    return { ok: true, done, skipped, ...(message ? { message } : {}) }
  }

  /**
   * Delete audio after (Settings → Meetings): removes the audio of meetings older than that, never a
   * transcript. Uses the store already loaded, else the bare store, and that only when the meetings
   * folder exists: the timer loads nothing on a Mac that never recorded. Returns how many it removed.
   */
  async sweepAudio(): Promise<number> {
    if (this.d.platform !== 'darwin') return 0
    const days = this.d.meetings().deleteAudioAfterDays
    if (days === null) return 0
    if (!this.svc && !existsSync(this.d.meetingsDir)) return 0
    const store = this.svc?.store ?? (await this.bareStore())
    const rows = janitorRows(store.sizes(), this.rec?.recording ? this.rec.meetingId : null)
    let n = 0
    for (const id of audioExpired(rows, days, (this.d.now ?? Date.now)())) {
      if (this.recordingNow(id)) continue
      const res = this.dropAudio(store, id)
      if (res.ok) n++
      else console.error(`meetings: delete audio after: ${res.message}`)
    }
    if (n) this.d.changed?.(null)
    return n
  }

  private sweepTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Called once the app is ready: the Delete audio after timer, first AUDIO_SWEEP_FIRST_MS after
   * start, then daily. Only timers: nothing is loaded or asked until one fires.
   */
  background(): void {
    if (this.d.platform !== 'darwin' || this.sweepTimer) return
    const sweep = () => void this.sweepAudio().catch((err) => console.error(`meetings: delete audio after: ${String(err)}`))
    this.sweepTimer = setTimeout(() => {
      sweep()
      this.sweepTimer = setInterval(sweep, AUDIO_SWEEP_EVERY_MS)
      this.sweepTimer.unref?.()
    }, AUDIO_SWEEP_FIRST_MS)
    this.sweepTimer.unref?.()
  }

  /** Stop the timers (quit, tests). */
  stopBackground(): void {
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer)
      clearInterval(this.sweepTimer)
    }
    this.sweepTimer = null
  }

  /**
   * The audio file the media scheme may serve for an id: the store's audio.webm of a meeting it
   * holds, in a real folder (not a link), else null. The window's session only (main/meetingMedia.ts).
   */
  async audioFile(id: string): Promise<string | null> {
    if (this.d.platform !== 'darwin' || !MEETING_ID.test(id)) return null
    const store = await this.pageStore()
    if (!store.get(id)) return null
    const p = store.audioPath(id)
    if (!p) return null
    try {
      const dir = lstatSync(dirname(p))
      if (!dir.isDirectory() || dir.isSymbolicLink()) return null
    } catch {
      return null
    }
    return isFileAt(p) ? p : null
  }

  /** Open on a meeting's item: it has been seen. */
  seen(id: string): void {
    this.d.notices?.clear(id, 'added')
  }

  /** The gate's answer with whether the picked model is on disk. */
  private async withModel(a: MeetingsAnswer): Promise<MeetingsAnswer> {
    if (!a.ok || !a.model.name) return a
    const { store } = await this.loadEngine()
    return { ...a, model: { ...a.model, ready: store.ready(a.model.name) } }
  }

  async setup(e: unknown): Promise<MeetingsAnswer> {
    const r = this.refused(e)
    if (r) return r
    // Settings → Meetings after consent: what a crash left gets transcribed now.
    this.warmService()
    return this.withModel((await this.loadGate()).setup())
  }

  /**
   * I agree (true) stores the consent; Turn off meetings (false) stops a recording, then clears it
   * and leaves the stored meetings.
   */
  async consent(e: unknown, agree: unknown): Promise<MeetingsAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (typeof agree !== 'boolean') return { ok: false, message: 'Not a consent.' }
    // Turn off during a recording: it stops first (its last chunks are written while the consent
    // still holds), then the consent goes. Nothing is recorded after turning off.
    if (!agree && this.rec?.recording) await this.rec.stop('consent')
    const m = this.d.meetings()
    this.d.setMeetings(
      agree
        ? { ...m, consentAt: (this.d.now ?? Date.now)(), consentVersion: MEETINGS_CONSENT_VERSION }
        : { ...m, consentAt: null, consentVersion: 0 },
    )
    if (agree) this.warmService()
    return this.withModel((await this.loadGate()).setup())
  }

  async permission(e: unknown, kind: unknown): Promise<MeetingsAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (kind !== 'mic' && kind !== 'screen') return { ok: false, message: 'Not a permission.' }
    // Checked here too, so a refusal never loads the gate.
    if (!meetingsAgreed({ meetings: this.d.meetings() })) return { ok: false, message: 'Agree to how meetings work first.' }
    // The Mac's sound is checked by a 1-second capture: the recorder provides it.
    if (kind === 'screen') await this.loadRecorder()
    return this.withModel(await (await this.loadGate()).permission(kind))
  }

  /** The models' state: what is on disk, the one picked, a download running, the speech engine. */
  private async models(message?: string): Promise<ModelsAnswer> {
    const { store, mod } = await this.loadEngine()
    const st = store.status()
    return {
      ok: true,
      picked: this.d.meetings().model,
      suggested: defaultModel(this.d.arch).id,
      models: MODELS.map((m) => ({ id: m.id, label: m.label, hint: m.hint, bytes: m.bytes, ready: st.models.find((x) => x.id === m.id)?.ready ?? false })),
      downloading: st.downloading,
      engine: mod.findWhisper(this.d.whisper()) !== null,
      ...(message ? { message } : {}),
    }
  }

  /**
   * Settings → Meetings' model row. pick stores settings.meetings.model; download (which also
   * picks) starts in the background and reports through progress(); cancel stops it; remove
   * deletes a model's file. Picking and downloading need the consent.
   */
  async model(e: unknown, op: unknown, id?: unknown): Promise<ModelsAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (!MODEL_OPS.includes(op as ModelOp)) return { ok: false, message: 'Not a model action.' }
    if (op === 'status') return this.models()
    if (op === 'cancel') {
      ;(await this.loadEngine()).store.cancel()
      return this.models()
    }
    const m = modelById(id)
    if (!m) return { ok: false, message: 'Not a speech model.' }
    if (op === 'remove') {
      const res = (await this.loadEngine()).store.remove(m.id)
      return this.models(res.ok ? undefined : res.message)
    }
    if (!meetingsAgreed({ meetings: this.d.meetings() })) return { ok: false, message: 'Agree to how meetings work first.' }
    const { store } = await this.loadEngine()
    // Checked before the pick is stored: a refused download changes nothing.
    if (op === 'download' && store.status().downloading) return this.models('A speech model is downloading already.')
    this.d.setMeetings({ ...this.d.meetings(), model: m.id })
    if (op === 'pick') {
      // A model already on disk: meetings waiting for one go on.
      if (store.ready(m.id)) this.svc?.transcriber.modelReady()
      return this.models()
    }
    // Not awaited: a download takes minutes; its end arrives as a progress with state done/failed.
    void store
      .download(m.id, (p) => this.d.progress(p))
      .then((res) => {
        if (res.ok) this.svc?.transcriber.modelReady()
      })
      .catch((err) => this.d.progress({ id: m.id, received: 0, total: m.bytes, state: 'failed', message: String(err) }))
    return this.models()
  }

  /** Restart MasterDeck (macOS may want it after a sound permission). The window only. */
  async restart(e: unknown): Promise<{ ok: boolean; message?: string }> {
    const r = this.refused(e)
    if (r) return r
    return (await this.d.restart()) ? { ok: true } : { ok: false, message: 'cancelled' }
  }
}

/** The part of an Electron session the media guard sets. */
export interface PermissionSession {
  setPermissionRequestHandler(h: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(h: (wc: unknown, permission: string) => boolean): void
}

/** The microphone and screen capture: refused in this session, or (the capture partition) allowed only while agreed. */
export function guardMedia(ses: PermissionSession, inCapture: boolean, agreed: () => boolean): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(mediaAllowed(permission, inCapture, agreed())))
  ses.setPermissionCheckHandler((_wc, permission) => mediaAllowed(permission, inCapture, agreed()))
}

/**
 * Guards every session: the default one (the window), the capture partition, and any made later.
 * Only sets handlers: it asks macOS nothing and opens no window.
 */
export function guardSessions(
  electronApp: { on(event: 'session-created', fn: (s: PermissionSession) => void): unknown },
  sessions: { defaultSession: PermissionSession; fromPartition(p: string): PermissionSession },
  agreed: () => boolean,
): void {
  const capture = sessions.fromPartition(CAPTURE_PARTITION)
  guardMedia(sessions.defaultSession, false, agreed)
  guardMedia(capture, true, agreed)
  electronApp.on('session-created', (s) => {
    if (s !== capture && s !== sessions.defaultSession) guardMedia(s, false, agreed)
  })
}
