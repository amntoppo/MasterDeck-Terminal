import {
  CAPTURE_PARTITION,
  IDLE_LIVE,
  MEETING_ID,
  MEETINGS_CONSENT_VERSION,
  MEETINGS_MAC_ONLY,
  mediaAllowed,
  meetingsAgreed,
  type MeetingLive,
  type MeetingsAnswer,
  type MeetingsSettings,
  type RecordAnswer,
} from '@shared/meetings'
import { defaultModel, MODEL_OPS, MODELS, modelById, type ModelOp, type ModelProgress, type ModelsAnswer } from '@shared/meetingModels'
import { isRemote } from './ipcRegistry'
// Types only: erased from the build, so this file never loads main/meetings/ by itself.
import type { MeetingsGate } from './meetings/gate'
import type { ModelStore, ModelStoreDeps } from './meetings/models'
import type { WhisperWhere } from './meetings/whisper'
import type { Recorder } from './meetings/recorder'
import type { MeetingStore } from './meetings/store'
import type { Transcriber } from './meetings/transcriber'

type GateModule = typeof import('./meetings/gate')
type EngineModule = typeof import('./meetings/models') & typeof import('./meetings/whisper')
type RecorderModule = typeof import('./meetings/recorder')
type ServiceModule = typeof import('./meetings/store') & typeof import('./meetings/transcriber')
/** The part of the recorder MeetingsIpc uses (tests pass a fake). */
export type RecorderLike = Pick<Recorder, 'start' | 'stop' | 'pause' | 'probe' | 'live' | 'recording' | 'meetingId'>
/** The meetings on disk and the transcription queue, loaded together after consent. */
export interface MeetingsService {
  store: MeetingStore
  transcriber: Transcriber
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
  /** A meeting is all text and `matching`: the matcher takes it (a later step). Unset: the meeting is done there. */
  onTranscribed?: (id: string) => void
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
  constructor(private d: MeetingsDeps) {}

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
    this.engine ??= load().then((mod) => {
      const store = new mod.ModelStore(this.d.modelsDir, this.d.fetch ? { fetch: this.d.fetch } : {})
      // What a quit or a crash in the middle of a download left (nothing downloads yet).
      store.cleanParts()
      this.engineMod = mod
      return { mod, store }
    })
    return this.engine
  }

  /**
   * The meetings on disk and the transcription queue, loaded once, only after consent (the first
   * Record, Settings → Meetings, Try again). Loading it finishes what a crash or a quit left: the
   * chunks on disk are queued first.
   */
  loadService(): Promise<MeetingsService> {
    this.service ??= this.loadEngine().then(async ({ store: models, mod: engine }) => {
      const load = this.d.loadService ?? (async () => ({ ...(await import('./meetings/store')), ...(await import('./meetings/transcriber')) }))
      const mod = await load()
      const store = new mod.MeetingStore(this.d.meetingsDir)
      const transcriber = new mod.Transcriber({
        store,
        // The model the meeting was recorded with, else the one picked now: the first on disk.
        modelPath: (m) => {
          for (const name of [m.model, this.d.meetings().model]) if (name && models.ready(name)) return models.path(name)
          return null
        },
        engine: () => engine.findWhisper(this.d.whisper()),
        transcribe: (o) => engine.transcribe(o),
        live: () => this.rec?.meetingId ?? null,
        onTranscribed: this.d.onTranscribed,
        now: this.d.now,
      })
      this.svc = { store, transcriber }
      transcriber.start()
      return this.svc
    })
    return this.service
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
    this.recorder ??= Promise.all([this.loadGate(), this.loadEngine(), this.loadService()]).then(async ([gate, { store: engine }, service]) => {
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
            onChange: () => this.d.onLive(),
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
    return this.recorder
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
    this.svc?.transcriber.stop()
    this.engineMod?.killRunning()
  }

  /** Try again on a meeting whose transcription failed (the Meetings page, Needs you). The window only. */
  async retry(e: unknown, id: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    const r = this.refused(e)
    if (r) return r
    if (typeof id !== 'string' || !MEETING_ID.test(id)) return { ok: false, message: 'No such meeting.' }
    if (!meetingsAgreed({ meetings: this.d.meetings() })) return { ok: false, message: 'Agree to how meetings work first (Settings → Meetings).' }
    return (await this.loadService()).transcriber.retry(id)
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

  /** I agree (true) stores the consent; Turn off meetings (false) clears it and leaves the stored meetings. */
  async consent(e: unknown, agree: unknown): Promise<MeetingsAnswer> {
    const r = this.refused(e)
    if (r) return r
    if (typeof agree !== 'boolean') return { ok: false, message: 'Not a consent.' }
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
