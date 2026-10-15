import { createHash } from 'node:crypto'
import { accessSync, constants, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { helperArgs, helperScript, HELPER_NAME } from '@shared/updateHelper'
import { compareVersions, type UpdateOffer } from '@shared/updates'
import type { Installer } from './updater'
import { PENDING } from './updater'
import { checkRelease, UpdateFailure } from './updateVerify'

// macOS's own updater (spec §4; no Apple Developer ID, so no Squirrel.Mac): download the zip with
// a streaming SHA-512, verify hash and signature before anything else, unpack it with ditto, check
// the staged version, and hand the swap to the helper script (shared/updateHelper.ts).

export type Run = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>

export interface MacDeps {
  /** <userData>/updates */
  dir: string
  /** The running bundle, e.g. /Applications/MasterDeck.app */
  bundle: string
  arch: string
  current: string
  publicKey: string
  pid: number
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  run: Run
  /** Start the helper, detached, outliving the app. */
  spawnDetached: (cmd: string, args: string[]) => void
  /** The normal quit (will-quit still closes the terminals and the remote line). */
  quit: () => void
  /** Whether a folder can be written (tests stand in). */
  writable?: (path: string) => boolean
  /** The download's timeout (ms). */
  downloadTimeoutMs?: number
}

/** The .app bundle of an executable (…/MasterDeck.app/Contents/MacOS/MasterDeck), or null. */
export function macBundle(exe: string): string | null {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)
  return m ? m[1] : null
}

/** Why a Mac app in this place cannot update itself, or null. */
export function macDisabledReason(bundle: string | null): string | null {
  if (!bundle) return 'MasterDeck is not running from an app bundle.'
  if (bundle.startsWith('/Volumes/')) return 'MasterDeck runs from a disk image. Move it to Applications to get updates.'
  if (bundle.includes('/AppTranslocation/'))
    return 'macOS runs MasterDeck from a temporary copy (App Translocation). Move it to Applications and open it again to get updates.'
  return null
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The version in a bundle's Info.plist (XML, as electron-builder writes it), or null. */
export function plistVersion(text: string): string | null {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)
  return m ? m[1].trim() : null
}

/**
 * After an install on quit (the helper kept the previous copy and watched nothing), the healthy new
 * app removes `.MasterDeck.app.previous` beside it: only when its own bundle is that MasterDeck.app
 * and the backup's version is older than the running one. True when it removed it. A folder the
 * user cannot write (an admin's /Applications) keeps the backup: the next update's swap replaces it.
 */
export function removeMacBackup(bundle: string, current: string): boolean {
  if (basename(bundle) !== 'MasterDeck.app') return false
  const prev = join(dirname(bundle), '.MasterDeck.app.previous')
  let version: string | null = null
  try {
    version = plistVersion(readFileSync(join(prev, 'Contents', 'Info.plist'), 'utf8'))
  } catch {
    return false
  }
  if (!version || compareVersions(version, current) >= 0) return false
  try {
    rmSync(prev, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export class MacInstaller implements Installer {
  constructor(private readonly d: MacDeps) {}

  private versionDir(v: string): string {
    return join(this.d.dir, v)
  }
  /** The unpacked new bundle, named like the zip's (MasterDeck.app). */
  private staged(v: string): string {
    return join(this.versionDir(v), 'stage', 'MasterDeck.app')
  }

  needsAdmin(): boolean {
    const w = this.d.writable ?? canWrite
    return !w(dirname(this.d.bundle)) || !w(this.d.bundle)
  }

  async prepare(offer: UpdateOffer, progress: (p: number) => void, verifying: () => void): Promise<void> {
    const vdir = this.versionDir(offer.version)
    rmSync(vdir, { recursive: true, force: true })
    mkdirSync(vdir, { recursive: true })
    const zip = join(vdir, offer.name)
    try {
      const got = await this.download(offer, zip, progress)
      verifying()
      checkRelease(got, offer, 'darwin', this.d.arch, this.d.publicKey)
    } catch (e) {
      // Nothing unverified stays on disk.
      rmSync(vdir, { recursive: true, force: true })
      throw e
    }
    try {
      await this.unpack(offer, zip)
    } catch (e) {
      rmSync(vdir, { recursive: true, force: true })
      throw e
    }
  }

  private async download(offer: UpdateOffer, file: string, progress: (p: number) => void): Promise<{ sha512: string; size: number }> {
    let res: Response
    const signal = AbortSignal.timeout(this.d.downloadTimeoutMs ?? 30 * 60_000)
    try {
      res = await this.d.fetch(offer.url, { signal })
    } catch {
      throw new UpdateFailure('download', 'Could not reach the update server')
    }
    if (res.status !== 200 || !res.body) throw new UpdateFailure('download', `The update server answered ${res.status}`)
    const hash = createHash('sha512')
    let size = 0
    let shown = -1
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        // More than the release's size is never the release: stop before it fills the disk.
        if (size > offer.size) return cb(new UpdateFailure('verify', 'The downloaded file does not match the release'))
        hash.update(chunk)
        const pct = Math.floor((size / offer.size) * 100)
        if (pct !== shown) {
          shown = pct
          progress(size / offer.size)
        }
        cb(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), count, createWriteStream(file))
    } catch (e) {
      if (e instanceof UpdateFailure) throw e
      throw new UpdateFailure('download', 'The download stopped before it finished')
    }
    return { sha512: hash.digest('base64'), size }
  }

  private async unpack(offer: UpdateOffer, zip: string): Promise<void> {
    const stage = dirname(this.staged(offer.version))
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    const r = await this.d.run('/usr/bin/ditto', ['-x', '-k', zip, stage])
    if (r.code !== 0) throw new UpdateFailure('install', 'The update could not be unpacked')
    // The zip stays until the install is done: an install that needs the administrator's password
    // unpacks it again as root, checked against its SHA-512, and never trusts this staged copy.
    const app = this.staged(offer.version)
    let version: string | null = null
    try {
      version = plistVersion(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'))
    } catch {
      /* missing: not the app */
    }
    if (version === null) {
      // A binary plist: plutil reads it.
      const p = await this.d.run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents', 'Info.plist')])
      if (p.code === 0) version = p.stdout.trim()
    }
    if (version !== offer.version) throw new UpdateFailure('verify', `The update holds version ${version ?? 'unknown'}, not ${offer.version}`)
    // Downloaded by Node, the files carry no quarantine; cleared anyway so Gatekeeper never asks.
    await this.d.run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app])
  }

  /** Write the helper and pending.json, start the helper detached. */
  private handOver(offer: UpdateOffer, relaunch: boolean): void {
    mkdirSync(this.d.dir, { recursive: true })
    const script = join(this.d.dir, HELPER_NAME)
    // Temp file + rename: a helper still running from an earlier install keeps reading its own copy.
    const tmp = `${script}.${process.pid}.tmp`
    writeFileSync(tmp, helperScript(), { mode: 0o755 })
    renameSync(tmp, script)
    const pending = join(this.d.dir, PENDING)
    // relaunch: false tells the new app that no helper watches it, so it removes the backup itself.
    writeFileSync(`${pending}.tmp`, JSON.stringify({ version: offer.version, from: this.d.current, relaunch, at: Date.now() }) + '\n')
    renameSync(`${pending}.tmp`, pending)
    const staged = this.staged(offer.version)
    const zip = join(this.versionDir(offer.version), offer.name)
    this.d.spawnDetached('/bin/bash', [
      script,
      ...helperArgs({
        pid: this.d.pid,
        app: this.d.bundle,
        staged,
        dir: this.d.dir,
        version: offer.version,
        from: this.d.current,
        relaunch,
        zip,
        sha512: offer.sha512,
      }),
    ])
  }

  async restart(offer: UpdateOffer): Promise<void> {
    try {
      this.handOver(offer, true)
    } catch (e) {
      throw new UpdateFailure('install', `The installer could not start (${(e as NodeJS.ErrnoException).code ?? 'error'})`)
    }
    this.d.quit()
  }

  onQuit(offer: UpdateOffer): void {
    this.handOver(offer, false)
  }

  discard(offer: UpdateOffer): void {
    rmSync(this.versionDir(offer.version), { recursive: true, force: true })
  }
}
