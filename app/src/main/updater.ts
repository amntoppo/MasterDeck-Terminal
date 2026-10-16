import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkUrl,
  CHECK_EVERY_MS,
  compareVersions,
  FIRST_CHECK_MS,
  HEALTHY_AFTER_MS,
  isVersion,
  parseOffer,
  parseResult,
  REMIND_MS,
  type UpdateChannel,
  type UpdateErrorKind,
  type UpdateOffer,
  type UpdateState,
} from '@shared/updates'
import { UpdateFailure } from './updateVerify'

// In-app updates (issue #122, spec §4): checks the backend, downloads through the platform's
// installer (updateMac.ts, updateWin.ts), and keeps the state Settings → Updates shows. Nothing here
// imports Electron: index.ts hands in fetch, the installer and the settings, so tests run it with fakes.

/** The platform part: macOS's own (updateMac.ts) or electron-updater's NSIS (updateWin.ts). */
export interface Installer {
  /** Download the offer's file, verify it (hash and signature) and stage it. Throws UpdateFailure. */
  prepare(offer: UpdateOffer, progress: (p: number) => void, verifying: () => void): Promise<void>
  /** Installing needs an administrator's password (the Mac's app folder is not writable). */
  needsAdmin(): boolean
  /** Restart now: hand over to the installer, which quits the app. Throws UpdateFailure. */
  restart(offer: UpdateOffer): Promise<void>
  /**
   * The app quits with the update ready. A normal quit installs it (macOS: swap without a relaunch;
   * Windows: electron-updater's install on quit). `relaunching`: MasterDeck's own Restart relaunches
   * it, so nothing may install under the new instance (Windows switches its install on quit off).
   */
  onQuit(offer: UpdateOffer, relaunching: boolean): void
  /** A staged update is no longer wanted (a newer one, or another channel): remove what it left. */
  discard?(offer: UpdateOffer): void
}

export interface UpdateSettings {
  autoDownloadUpdates: boolean
  updateChannel: UpdateChannel
}

export interface UpdaterDeps {
  current: string
  platform: string
  arch: string
  /** <userData>/updates */
  dir: string
  /** The backend, e.g. https://dev.masterdeck.dev */
  base: string
  /** Why updates are off (dev build, MASTERDECK_UPDATES=0, a read-only place), or null. */
  disabledReason: string | null
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>
  settings: () => UpdateSettings
  /** Made on first use (Windows loads electron-updater then). */
  installer: (id: string) => Installer | Promise<Installer>
  now?: () => number
  log?: (m: string) => void
  /** The check's timeout (ms). */
  timeoutMs?: number
  /**
   * macOS, after an install on quit (no helper watching): the healthy new version removes the
   * previous copy the helper kept (updateMac.ts removeMacBackup).
   */
  removeBackup?: () => void
}

export const PENDING = 'pending.json'
export const RESULT = 'result.json'
export const ROLLED_BACK = 'rolled-back.json'
const INSTALL_ID = 'install-id'

/** Why updates are off on this machine, or null (spec §4: packaged only, MASTERDECK_UPDATES=0, a Mac app in a read-only place). */
export function updatesOffReason(o: { env: Record<string, string | undefined>; packaged: boolean; platform: string; macReason?: string | null }): string | null {
  if (o.env.MASTERDECK_UPDATES === '0') return 'Updates are switched off (MASTERDECK_UPDATES=0).'
  if (!o.packaged) return 'Updates work in the installed app, not in a development build.'
  if (o.platform === 'darwin') return o.macReason ?? null
  if (o.platform !== 'win32') return 'Updates are not available on this system.'
  return null
}

/** Write a small file by temp file + rename. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

function errorKind(e: unknown, fallback: UpdateErrorKind): UpdateErrorKind {
  return e instanceof UpdateFailure ? e.kind : fallback
}
function errorText(e: unknown, fallback: string): string {
  return e instanceof UpdateFailure ? e.message : fallback
}

export class Updater {
  private s: UpdateState
  private listeners = new Set<(s: UpdateState) => void>()
  private timers: ReturnType<typeof setTimeout>[] = []
  private every: ReturnType<typeof setInterval> | null = null
  private checking: Promise<UpdateState> | null = null
  private preparing: Promise<UpdateState> | null = null
  private inst: Installer | null = null
  private id: string | null = null
  /** A check asked for while another check or a download ran (the channel changed meanwhile). */
  private recheck = false
  private readonly now: () => number

  constructor(private readonly d: UpdaterDeps) {
    this.now = d.now ?? Date.now
    this.s = {
      current: d.current,
      platform: d.platform,
      arch: d.arch,
      enabled: d.disabledReason === null,
      ...(d.disabledReason ? { disabledReason: d.disabledReason } : {}),
      phase: 'idle',
      mandatory: false,
    }
  }

  state(): UpdateState {
    return { ...this.s }
  }

  on(cb: (s: UpdateState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(patch: Partial<UpdateState>, drop: (keyof UpdateState)[] = []): void {
    const next = { ...this.s, ...patch }
    for (const k of drop) delete next[k]
    this.s = next
    for (const cb of this.listeners) cb(this.state())
  }

  private log(m: string): void {
    ;(this.d.log ?? ((x: string) => console.error(x)))(`updates: ${m}`)
  }

  /** At launch: what the last install left, then the schedule (30 s, then every 6 h). */
  start(): void {
    this.readLaunchFiles()
    if (!this.s.enabled) return
    this.timers.push(setTimeout(() => void this.check(), FIRST_CHECK_MS))
    this.every = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    if (this.every) clearInterval(this.every)
    this.every = null
  }

  /** This install's random id (the server's staged rollout buckets by it). */
  installId(): string {
    if (this.id) return this.id
    const f = join(this.d.dir, INSTALL_ID)
    try {
      const v = readFileSync(f, 'utf8').trim()
      if (/^[0-9a-f-]{36}$/i.test(v)) return (this.id = v)
    } catch {
      /* first run */
    }
    const id = randomUUID()
    try {
      mkdirSync(this.d.dir, { recursive: true })
      writeAtomic(f, id + '\n')
    } catch (e) {
      this.log(`install id not saved: ${String(e)}`)
    }
    return (this.id = id)
  }

  private skipped(): string | null {
    return this.s.rolledBack?.version ?? null
  }

  /** Ask the server; with automatic downloads on, an offer downloads at once. */
  check(): Promise<UpdateState> {
    if (!this.s.enabled) return Promise.resolve(this.state())
    if (this.checking) return this.checking
    if (this.s.phase === 'downloading' || this.s.phase === 'verifying' || this.s.phase === 'installing') return Promise.resolve(this.state())
    this.checking = this.doCheck().finally(() => {
      this.checking = null
      this.afterBusy()
    })
    return this.checking
  }

  /** Run a check that was asked for while busy, once nothing runs any more. */
  private afterBusy(): void {
    if (!this.recheck || this.checking || this.preparing) return
    this.recheck = false
    void this.check()
  }

  /** Tell the installer a staged update is not wanted any more (its files go at once). */
  private discard(offer: UpdateOffer): void {
    try {
      this.inst?.discard?.(offer)
    } catch (e) {
      this.log(`discard ${offer.version}: ${String(e)}`)
    }
  }

  private async doCheck(): Promise<UpdateState> {
    const { updateChannel } = this.d.settings()
    // A beta offer while the setting is stable is not wanted any more: drop it (and its staged files).
    const offered = this.s.offer
    if (offered && offered.channel === 'beta' && updateChannel === 'stable') {
      if (this.s.phase === 'ready') this.discard(offered)
      this.set({ phase: 'checking', mandatory: false }, ['offer', 'progress', 'needsAdmin', 'remindAt'])
    }
    const ready = this.s.phase === 'ready' ? this.s.offer : undefined
    // A ready update stays ready while a check runs; only a newer offer replaces it.
    if (!ready) this.set({ phase: 'checking' }, ['error', 'errorKind'])
    const url = checkUrl(this.d.base, {
      version: this.d.current,
      platform: this.d.platform,
      arch: this.d.arch,
      channel: updateChannel,
      id: this.installId(),
    })
    let status: number
    let body: unknown = null
    try {
      const res = await this.d.fetch(url, { signal: AbortSignal.timeout(this.d.timeoutMs ?? 20_000) })
      status = res.status
      if (status === 200) body = await res.json()
    } catch (e) {
      this.log(`check: ${String(e)}`)
      if (ready) return this.state()
      this.set({ phase: 'error', errorKind: 'offline', error: 'Could not reach the update server', lastChecked: this.now() })
      return this.state()
    }
    const lastChecked = this.now()
    if (status === 204) return this.nothing(ready, lastChecked)
    const offer = status === 200 ? parseOffer(body) : null
    if (!offer) {
      if (ready) return this.state()
      const why = status === 429 ? 'Too many update checks; try again later' : status === 200 ? 'The update server sent an answer MasterDeck cannot read' : `The update server answered ${status}`
      this.set({ phase: 'error', errorKind: 'check', error: why, lastChecked })
      return this.state()
    }
    if (compareVersions(offer.version, this.d.current) <= 0 || offer.version === this.skipped()) return this.nothing(ready, lastChecked)
    if (ready && compareVersions(offer.version, ready.version) <= 0) {
      this.set({ lastChecked })
      return this.state()
    }
    // A newer offer replaces a ready one: the old staged copy goes at once.
    if (ready) this.discard(ready)
    this.set({ phase: 'available', offer, mandatory: offer.mandatory, lastChecked }, ['progress', 'error', 'errorKind', 'remindAt', 'needsAdmin'])
    if (this.d.settings().autoDownloadUpdates) return this.download()
    return this.state()
  }

  private nothing(ready: UpdateOffer | undefined, lastChecked: number): UpdateState {
    if (ready) this.set({ lastChecked })
    else this.set({ phase: 'up-to-date', mandatory: false, lastChecked }, ['offer', 'progress', 'error', 'errorKind'])
    return this.state()
  }

  private async installer(): Promise<Installer> {
    if (!this.inst) this.inst = await this.d.installer(this.installId())
    return this.inst
  }

  /** Download, verify and stage the offer (Settings' Download, or at once with automatic downloads). */
  download(): Promise<UpdateState> {
    if (this.preparing) return this.preparing
    const offer = this.s.offer
    const can = this.s.phase === 'available' || (this.s.phase === 'error' && (this.s.errorKind === 'download' || this.s.errorKind === 'verify'))
    if (!this.s.enabled || !offer || !can) return Promise.resolve(this.state())
    this.preparing = this.doDownload(offer).finally(() => {
      this.preparing = null
      this.afterBusy()
    })
    return this.preparing
  }

  private async doDownload(offer: UpdateOffer): Promise<UpdateState> {
    this.set({ phase: 'downloading', progress: 0 }, ['error', 'errorKind'])
    try {
      const inst = await this.installer()
      await inst.prepare(
        offer,
        (p) => {
          if (this.s.phase === 'downloading') this.set({ progress: Math.max(0, Math.min(1, p)) })
        },
        () => this.set({ phase: 'verifying' }, ['progress']),
      )
      this.set({ phase: 'ready', needsAdmin: inst.needsAdmin() }, ['progress'])
    } catch (e) {
      this.log(`download ${offer.version}: ${String(e)}`)
      this.set({ phase: 'error', errorKind: errorKind(e, 'download'), error: errorText(e, 'The download failed') }, ['progress'])
    }
    return this.state()
  }

  /** Restart now: the installer takes over and the app quits. The caller asked about a recording first. */
  async restart(): Promise<{ ok: boolean; message?: string }> {
    const offer = this.s.offer
    if (this.s.phase !== 'ready' || !offer) return { ok: false, message: 'No update is ready' }
    this.set({ phase: 'installing' })
    try {
      await (await this.installer()).restart(offer)
      return { ok: true }
    } catch (e) {
      this.log(`restart: ${String(e)}`)
      const kind = errorKind(e, 'install')
      // The staged update is still there: back to ready, with the error shown.
      this.set({ phase: kind === 'verify' ? 'error' : 'ready', errorKind: kind, error: errorText(e, 'The update could not be installed') })
      // A channel change asked for while installing checks now, not at the next 6-hourly check.
      this.afterBusy()
      return { ok: false, message: this.s.error }
    }
  }

  /** Remind me later: no prompt for four hours (this run only). */
  remindLater(): UpdateState {
    this.set({ remindAt: this.now() + REMIND_MS })
    return this.state()
  }

  /**
   * Settings changed: another channel checks again (after a check or download already running);
   * automatic downloads switched on take a waiting offer.
   */
  settingsChanged(prev: UpdateSettings, next: UpdateSettings): void {
    if (!this.s.enabled) return
    if (prev.updateChannel !== next.updateChannel) {
      if (this.checking || this.preparing || this.s.phase === 'installing') this.recheck = true
      else void this.check()
    } else if (!prev.autoDownloadUpdates && next.autoDownloadUpdates && this.s.phase === 'available') void this.download()
  }

  /**
   * A normal quit (will-quit): a ready update is installed (macOS: swapped in, unless that needs a
   * password). Never when MasterDeck's own Restart relaunches: the new instance would start from the
   * bundle the helper is about to move away, or under the NSIS installer; the installer is told so
   * (Windows switches electron-updater's install on quit off).
   */
  onQuit(relaunching = false): void {
    if (this.s.phase !== 'ready' || !this.s.offer || !this.inst) return
    if (!relaunching && this.s.needsAdmin) return
    try {
      this.inst.onQuit(this.s.offer, relaunching)
    } catch (e) {
      this.log(`install on quit: ${String(e)}`)
    }
  }

  /**
   * The window loaded. When this launch is the update pending.json names, write the health marker
   * the helper waits for 10 s later, then pick up its result. After an install on quit (no helper
   * watching) the healthy app removes the previous copy itself.
   */
  windowLoaded(): void {
    const pending = this.readPending()
    if (!pending) return
    if (pending.version !== this.d.current) {
      // Rolled back (or an older copy opened): the helper's result says what happened.
      this.remove(PENDING)
      return
    }
    this.timers.push(
      setTimeout(() => {
        try {
          mkdirSync(this.d.dir, { recursive: true })
          writeFileSync(join(this.d.dir, `healthy-${this.d.current}`), String(this.now()))
          this.remove(PENDING)
          // Restart now (or a pending.json from before the field): the helper removes the backup.
          if (pending.relaunch === false) this.d.removeBackup?.()
        } catch (e) {
          this.log(`health marker: ${String(e)}`)
        }
        // The helper writes result.json within a second of seeing the marker.
        for (const ms of [3_000, 15_000]) this.timers.push(setTimeout(() => this.readResult(), ms))
      }, HEALTHY_AFTER_MS),
    )
  }

  private readPending(): { version: string; relaunch?: boolean } | null {
    try {
      const v = JSON.parse(readFileSync(join(this.d.dir, PENDING), 'utf8'))
      return v && isVersion(v.version) ? { version: v.version, ...(typeof v.relaunch === 'boolean' ? { relaunch: v.relaunch } : {}) } : null
    } catch {
      return null
    }
  }

  private remove(name: string): void {
    try {
      rmSync(join(this.d.dir, name), { force: true })
    } catch {
      /* gone */
    }
  }

  /** At launch: the skipped version, the helper's result, and staged folders no longer needed. */
  readLaunchFiles(): void {
    try {
      const rb = JSON.parse(readFileSync(join(this.d.dir, ROLLED_BACK), 'utf8'))
      if (rb && isVersion(rb.version) && compareVersions(this.d.current, rb.version) < 0)
        this.s.rolledBack = { version: rb.version, reason: String(rb.reason ?? 'unhealthy').slice(0, 40), at: Number(rb.at) || 0 }
      else this.remove(ROLLED_BACK)
    } catch {
      /* none */
    }
    this.readResult()
    // A launch never holds a staged update (the state is in memory): every <version>/ folder is stale.
    // The health check's pending.json keeps its folder until the helper has moved the app out.
    if (!existsSync(join(this.d.dir, PENDING)))
      try {
        for (const n of readdirSync(this.d.dir))
          if (isVersion(n) && statSync(join(this.d.dir, n)).isDirectory()) rmSync(join(this.d.dir, n), { recursive: true, force: true })
      } catch {
        /* no folder yet */
      }
  }

  /** result.json (the macOS helper): updated, rolled back, or the swap failed. Read once, then removed. */
  readResult(): void {
    let text: string
    try {
      text = readFileSync(join(this.d.dir, RESULT), 'utf8')
    } catch {
      return
    }
    this.remove(RESULT)
    const r = parseResult(text)
    if (!r) return
    if (r.ok) {
      if (r.version === this.d.current) this.set({ updatedFrom: { from: r.from, at: r.at } })
      return
    }
    if (r.reason === 'unhealthy') {
      // The new version did not start: skipped until a newer one is offered.
      const rolledBack = { version: r.version, reason: r.reason, at: r.at }
      try {
        mkdirSync(this.d.dir, { recursive: true })
        writeAtomic(join(this.d.dir, ROLLED_BACK), JSON.stringify(rolledBack) + '\n')
      } catch (e) {
        this.log(`rolled-back.json: ${String(e)}`)
      }
      this.set({ rolledBack })
      return
    }
    const permission = r.reason === 'permission'
    this.set({
      phase: 'error',
      errorKind: permission ? 'permission' : 'install',
      error: permission
        ? `MasterDeck ${r.version} was not installed: the administrator password was not given`
        : r.reason === 'still-running'
          ? `MasterDeck ${r.version} was not installed: MasterDeck did not quit in time`
          : `MasterDeck ${r.version} could not be installed`,
    })
  }
}
