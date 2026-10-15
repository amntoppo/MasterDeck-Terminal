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
  arch: string
  publicKey: string
  /** Makes the updater for a feed URL; electron-updater is loaded only here, on win32. */
  make: (feedUrl: string) => Promise<NsisLike>
}

/** The generic-provider feed for this install: the server answers latest.yml with what the check would offer it. */
export function feedUrl(base: string, channel: UpdateChannel, id: string): string {
  return `${base}/v1/updates/feed/${channel}/${encodeURIComponent(id)}/`
}

/** The real maker: electron-updater, loaded lazily. */
export async function nsisUpdater(feed: string): Promise<NsisLike> {
  const { NsisUpdater } = await import('electron-updater')
  const u = new NsisUpdater({ provider: 'generic', url: feed })
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
    const u = await this.d.make(feedUrl(this.d.base, this.d.channel(), this.d.id))
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
    this.u.quitAndInstall(true, true)
  }

  onQuit(): void {
    // electron-updater installs on quit itself (autoInstallOnAppQuit).
  }
}
