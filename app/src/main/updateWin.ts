import { rmSync } from 'node:fs'
import type { UpdateChannel, UpdateOffer } from '@shared/updates'
import type { Installer } from './updater'
import { checkRelease, hashFile, UpdateFailure } from './updateVerify'

// Windows (spec §4): electron-updater's NsisUpdater against the backend's per-install feed, so the
// server's rollout decides; MasterDeck still checks the downloaded installer's hash and signature
// itself before it counts as ready. ponytail: no automatic rollback on Windows (NSIS replaces the
// install); upgrade path: keep the previous installer and rerun it on a failed health check.

/** The part of electron-updater's NsisUpdater used here (the real class satisfies it). */
export interface NsisLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', cb: (p: { percent: number }) => void): unknown
}

export interface WinDeps {
  base: string
  channel: () => UpdateChannel
  id: string
  /** This app's version: the feed answers what the check would offer it (mandatory updates included). */
  current: string
  arch: string
  publicKey: string
  /** Makes the updater for a feed URL; electron-updater is loaded only here, on win32. */
  make: (feedUrl: string) => Promise<NsisLike>
  /** How long Restart now waits for the app to quit before it says the installer did not start (ms). */
  quitWaitMs?: number
}

/**
 * The generic-provider feed for this install and version: the server answers latest.yml with what
 * the check would offer it, so the feed and /check agree on rollout and mandatory updates.
 */
export function feedUrl(base: string, channel: UpdateChannel, id: string, current: string): string {
  return `${base}/v1/updates/feed/${channel}/${encodeURIComponent(id)}/${encodeURIComponent(current)}/`
}

/**
 * NsisUpdater's options. The backend answers single ranges only, so electron-updater asks for one
 * range per request (its multi-range request would fail and fall back to a full download).
 */
export function nsisOptions(feed: string): { provider: 'generic'; url: string; useMultipleRangeRequest: false } {
  return { provider: 'generic', url: feed, useMultipleRangeRequest: false }
}

/** The real maker: electron-updater, loaded lazily. */
export async function nsisUpdater(feed: string): Promise<NsisLike> {
  const { NsisUpdater } = await import('electron-updater')
  const u = new NsisUpdater(nsisOptions(feed))
  u.logger = { info: () => {}, warn: (m: unknown) => console.error(`updates: ${String(m)}`), error: (m: unknown) => console.error(`updates: ${String(m)}`) }
  return u as unknown as NsisLike
}

export class WinInstaller implements Installer {
  private u: NsisLike | null = null

  constructor(private readonly d: WinDeps) {}

  needsAdmin(): boolean {
    return false
  }

  async prepare(offer: UpdateOffer, progress: (p: number) => void, verifying: () => void): Promise<void> {
    // A newer offer replaces a ready one: the old updater must not install on quit any more.
    this.discard()
    const u = await this.d.make(feedUrl(this.d.base, this.d.channel(), this.d.id, this.d.current))
    u.autoDownload = false
    u.autoInstallOnAppQuit = false
    u.allowDowngrade = false
    let found: Awaited<ReturnType<NsisLike['checkForUpdates']>>
    try {
      found = await u.checkForUpdates()
    } catch {
      throw new UpdateFailure('download', 'Could not read the update feed')
    }
    if (found?.updateInfo.version !== offer.version) throw new UpdateFailure('download', `The update feed does not offer ${offer.version}`)
    u.on('download-progress', (p) => progress((p.percent ?? 0) / 100))
    let files: string[]
    try {
      files = await u.downloadUpdate()
    } catch {
      throw new UpdateFailure('download', 'The download failed')
    }
    const file = files[0]
    if (!file) throw new UpdateFailure('download', 'The download failed')
    verifying()
    try {
      checkRelease(await hashFile(file), offer, 'win32', this.d.arch, this.d.publicKey)
    } catch (e) {
      rmSync(file, { force: true })
      throw e instanceof UpdateFailure ? e : new UpdateFailure('verify', 'The downloaded file could not be read')
    }
    // Verified: from now on a normal quit installs it too.
    u.autoInstallOnAppQuit = true
    this.u = u
  }

  async restart(): Promise<void> {
    if (!this.u) throw new UpdateFailure('install', 'No update is ready')
    try {
      this.u.quitAndInstall(true, true)
    } catch {
      throw new UpdateFailure('install', 'The installer could not start')
    }
    // quitAndInstall quits the app; still here after the wait, it did not (Settings shows the error).
    await new Promise((r) => setTimeout(r, this.d.quitWaitMs ?? 10_000))
    throw new UpdateFailure('install', 'The installer did not start')
  }

  discard(): void {
    if (this.u) this.u.autoInstallOnAppQuit = false
    this.u = null
  }

  onQuit(_offer: UpdateOffer, relaunching: boolean): void {
    // A normal quit: electron-updater installs on quit itself (autoInstallOnAppQuit). MasterDeck's
    // own Restart relaunches the app: the installer must not run under the new instance (will-quit
    // comes before electron-updater's quit handler, which reads the flag then). The update stays
    // downloaded; the relaunched app offers it again.
    if (relaunching && this.u) this.u.autoInstallOnAppQuit = false
  }
}
