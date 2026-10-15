import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEALTHY_AFTER_MS, REMIND_MS, signedMessage, type UpdateOffer } from '@shared/updates'
import { Updater, updatesOffReason, type Installer, type UpdaterDeps, type UpdateSettings } from './updater'
import { MacInstaller, macBundle, macDisabledReason, plistVersion, type Run } from './updateMac'
import { UpdateFailure } from './updateVerify'
import { feedUrl, WinInstaller, type NsisLike } from './updateWin'

// The updater against a fake server and fake installers, and macOS's installer against fake
// downloads in a temp dir. Nothing here reaches the network, /Applications or a real app.

const keys = generateKeyPairSync('ed25519')
const PUB = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64')

const ZIP = Buffer.from('pretend this is MasterDeck-0.10.0-arm64-mac.zip')
const sha = (b: Buffer) => createHash('sha512').update(b).digest('base64')

function signedOffer(over: Partial<UpdateOffer> = {}, platform = 'darwin', arch = 'arm64'): UpdateOffer {
  const o: UpdateOffer = {
    version: '0.10.0',
    channel: 'stable',
    notes: 'New things',
    name: 'MasterDeck-0.10.0-arm64-mac.zip',
    url: 'https://updates.test/v1/updates/files/0.10.0/MasterDeck-0.10.0-arm64-mac.zip',
    sha512: sha(ZIP),
    size: ZIP.length,
    signature: '',
    publishedAt: 1,
    mandatory: false,
    ...over,
  }
  if (!over.signature)
    o.signature = sign(null, Buffer.from(signedMessage({ version: o.version, platform, arch, name: o.name, sha512: o.sha512 })), keys.privateKey).toString('base64')
  return o
}

let dir: string
let settings: UpdateSettings
let calls: string[]

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'md updates ')), 'updates')
  settings = { autoDownloadUpdates: true, updateChannel: 'stable' }
  calls = []
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

type Answer = { status: number; body?: unknown } | Error

function fakeInstaller(over: Partial<Installer> = {}): Installer {
  return {
    prepare: async (_o, progress, verifying) => {
      calls.push('prepare')
      progress(0.5)
      verifying()
    },
    needsAdmin: () => false,
    restart: async () => {
      calls.push('restart')
    },
    onQuit: () => calls.push('onQuit'),
    ...over,
  }
}

function makeUpdater(answer: Answer | (() => Answer), over: Partial<UpdaterDeps> = {}): { u: Updater; urls: string[] } {
  const urls: string[] = []
  const u = new Updater({
    current: '0.9.0',
    platform: 'darwin',
    arch: 'arm64',
    dir,
    base: 'https://updates.test',
    disabledReason: null,
    fetch: async (url) => {
      urls.push(url)
      const a = typeof answer === 'function' ? answer() : answer
      if (a instanceof Error) throw a
      return { status: a.status, json: async () => a.body }
    },
    settings: () => settings,
    installer: () => fakeInstaller(),
    log: () => {},
    ...over,
  })
  return { u, urls }
}

describe('Updater.check', () => {
  it('204: up to date, with the install id and channel in the query', async () => {
    const { u, urls } = makeUpdater({ status: 204 })
    const s = await u.check()
    expect(s.phase).toBe('up-to-date')
    expect(s.lastChecked).toBeTypeOf('number')
    const id = readFileSync(join(dir, 'install-id'), 'utf8').trim()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(urls[0]).toBe(`https://updates.test/v1/updates/check?version=0.9.0&platform=darwin&arch=arm64&channel=stable&id=${id}`)
    // The id stays the same.
    await u.check()
    expect(urls[1]).toContain(`id=${id}`)
  })

  it('an offer downloads at once with automatic downloads on, and ends ready', async () => {
    const seen: string[] = []
    const { u } = makeUpdater({ status: 200, body: signedOffer() })
    u.on((s) => seen.push(s.phase))
    const s = await u.check()
    expect(s.phase).toBe('ready')
    expect(s.offer?.version).toBe('0.10.0')
    expect(seen).toEqual(['checking', 'available', 'downloading', 'downloading', 'verifying', 'ready'])
    expect(calls).toEqual(['prepare'])
  })

  it('automatic downloads off: available until Download', async () => {
    settings.autoDownloadUpdates = false
    const { u } = makeUpdater({ status: 200, body: signedOffer() })
    expect((await u.check()).phase).toBe('available')
    expect(calls).toEqual([])
    expect((await u.download()).phase).toBe('ready')
  })

  it('switching automatic downloads on takes the waiting offer', async () => {
    settings.autoDownloadUpdates = false
    const { u } = makeUpdater({ status: 200, body: signedOffer() })
    await u.check()
    u.settingsChanged({ ...settings }, { ...settings, autoDownloadUpdates: true })
    await vi.waitFor(() => expect(u.state().phase).toBe('ready'))
  })

  it('another channel checks again', async () => {
    const { u, urls } = makeUpdater({ status: 204 })
    settings.updateChannel = 'beta'
    u.settingsChanged({ autoDownloadUpdates: true, updateChannel: 'stable' }, settings)
    await vi.waitFor(() => expect(urls).toHaveLength(1))
    expect(urls[0]).toContain('channel=beta')
  })

  it('offline and server errors are told apart', async () => {
    const off = makeUpdater(new TypeError('fetch failed')).u
    expect(await off.check()).toMatchObject({ phase: 'error', errorKind: 'offline' })
    const bad = makeUpdater({ status: 500 }).u
    expect(await bad.check()).toMatchObject({ phase: 'error', errorKind: 'check', error: 'The update server answered 500' })
    const junk = makeUpdater({ status: 200, body: { version: 'x' } }).u
    expect(await junk.check()).toMatchObject({ phase: 'error', errorKind: 'check' })
  })

  it('an offer not newer than this version is up to date', async () => {
    const { u } = makeUpdater({ status: 200, body: signedOffer({ version: '0.9.0' }) })
    expect((await u.check()).phase).toBe('up-to-date')
  })

  it('a ready update stays ready across a check that finds nothing newer', async () => {
    let answer: Answer = { status: 200, body: signedOffer() }
    const { u } = makeUpdater(() => answer)
    await u.check()
    answer = new TypeError('offline')
    expect((await u.check()).phase).toBe('ready')
    answer = { status: 204 }
    expect((await u.check()).phase).toBe('ready')
  })

  it('does nothing when updates are off', async () => {
    const { u, urls } = makeUpdater({ status: 204 }, { disabledReason: 'dev build' })
    expect(await u.check()).toMatchObject({ enabled: false, disabledReason: 'dev build', phase: 'idle' })
    expect(urls).toEqual([])
  })

  it('a failed verify is an error the user can retry with Download', async () => {
    let fail = true
    const { u } = makeUpdater(
      { status: 200, body: signedOffer() },
      {
        installer: () =>
          fakeInstaller({
            prepare: async () => {
              if (fail) throw new UpdateFailure('verify', 'The release signature is not valid')
            },
          }),
      },
    )
    expect(await u.check()).toMatchObject({ phase: 'error', errorKind: 'verify', error: 'The release signature is not valid' })
    fail = false
    expect((await u.download()).phase).toBe('ready')
  })
})

describe('Updater: ready, restart, remind later, quit', () => {
  it('remind later snoozes the prompt for four hours', async () => {
    const { u } = makeUpdater({ status: 200, body: signedOffer() }, { now: () => 1000 })
    await u.check()
    expect(u.remindLater().remindAt).toBe(1000 + REMIND_MS)
  })

  it('restart hands over to the installer; a failure keeps the update ready with the error', async () => {
    let refuse = false
    const { u } = makeUpdater(
      { status: 200, body: signedOffer() },
      {
        installer: () =>
          fakeInstaller({
            restart: async () => {
              if (refuse) throw new UpdateFailure('install', 'The installer could not start (EACCES)')
              calls.push('restart')
            },
          }),
      },
    )
    expect(await u.restart()).toEqual({ ok: false, message: 'No update is ready' })
    await u.check()
    refuse = true
    expect(await u.restart()).toEqual({ ok: false, message: 'The installer could not start (EACCES)' })
    expect(u.state()).toMatchObject({ phase: 'ready', errorKind: 'install' })
    refuse = false
    expect(await u.restart()).toEqual({ ok: true })
    expect(u.state().phase).toBe('installing')
    // The quit that follows does not start a second install.
    u.onQuit()
    expect(calls).toEqual(['prepare', 'restart'])
  })

  it('a normal quit installs a ready update, unless that needs a password', async () => {
    const { u } = makeUpdater({ status: 200, body: signedOffer() })
    u.onQuit()
    expect(calls).toEqual([])
    await u.check()
    u.onQuit()
    expect(calls).toEqual(['prepare', 'onQuit'])
    const admin = makeUpdater({ status: 200, body: signedOffer() }, { installer: () => fakeInstaller({ needsAdmin: () => true }) }).u
    await admin.check()
    expect(admin.state().needsAdmin).toBe(true)
    calls = []
    admin.onQuit()
    expect(calls).toEqual([])
  })
})

describe('Updater: what the last install left', () => {
  it('a rolled-back result is shown and that version is skipped until a newer one', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'result.json'), '{"ok":false,"version":"0.10.0","reason":"unhealthy","at":5000}\n')
    const { u } = makeUpdater({ status: 200, body: signedOffer() })
    u.start()
    u.stop()
    expect(u.state().rolledBack).toEqual({ version: '0.10.0', reason: 'unhealthy', at: 5000 })
    expect(existsSync(join(dir, 'result.json'))).toBe(false)
    expect((await u.check()).phase).toBe('up-to-date')
    // The next launch still skips it.
    const again = makeUpdater({ status: 200, body: signedOffer() }).u
    again.readLaunchFiles()
    expect(again.state().rolledBack?.version).toBe('0.10.0')
    expect((await again.check()).phase).toBe('up-to-date')
    // A newer one is offered.
    const newer = makeUpdater({ status: 200, body: signedOffer({ version: '0.10.1' }) }).u
    newer.readLaunchFiles()
    expect((await newer.check()).phase).toBe('ready')
  })

  it('an ok result says Updated from; a refused password is an error, not a skip', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'result.json'), '{"ok":true,"from":"0.8.2","version":"0.9.0","at":7}\n')
    const { u } = makeUpdater({ status: 204 })
    u.readLaunchFiles()
    expect(u.state().updatedFrom).toEqual({ from: '0.8.2', at: 7 })
    writeFileSync(join(dir, 'result.json'), '{"ok":false,"version":"0.10.0","reason":"permission","at":7}\n')
    const p = makeUpdater({ status: 204 }).u
    p.readLaunchFiles()
    expect(p.state()).toMatchObject({ phase: 'error', errorKind: 'permission' })
    expect(p.state().rolledBack).toBeUndefined()
  })

  it('removes stale staged folders at launch, never install-id', () => {
    mkdirSync(join(dir, '0.10.0', 'stage'), { recursive: true })
    writeFileSync(join(dir, 'install-id'), '00000000-0000-4000-8000-000000000000\n')
    makeUpdater({ status: 204 }).u.readLaunchFiles()
    expect(readdirSync(dir)).toEqual(['install-id'])
  })

  it('the new version writes its health marker 10 s after the window loaded', () => {
    vi.useFakeTimers()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pending.json'), '{"version":"0.9.0","from":"0.8.2"}\n')
    const { u } = makeUpdater({ status: 204 })
    u.windowLoaded()
    vi.advanceTimersByTime(HEALTHY_AFTER_MS - 1)
    expect(existsSync(join(dir, 'healthy-0.9.0'))).toBe(false)
    vi.advanceTimersByTime(1)
    expect(existsSync(join(dir, 'healthy-0.9.0'))).toBe(true)
    expect(existsSync(join(dir, 'pending.json'))).toBe(false)
    // The helper's result is picked up a few seconds later.
    writeFileSync(join(dir, 'result.json'), '{"ok":true,"from":"0.8.2","version":"0.9.0","at":7}\n')
    vi.advanceTimersByTime(3_000)
    expect(u.state().updatedFrom).toEqual({ from: '0.8.2', at: 7 })
    u.stop()
  })

  it('another version pending (rolled back): no marker, pending.json goes', () => {
    vi.useFakeTimers()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pending.json'), '{"version":"0.10.0","from":"0.9.0"}\n')
    makeUpdater({ status: 204 }).u.windowLoaded()
    vi.advanceTimersByTime(HEALTHY_AFTER_MS)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('updatesOffReason', () => {
  it('needs a packaged app on macOS or Windows, and honours MASTERDECK_UPDATES=0', () => {
    expect(updatesOffReason({ env: {}, packaged: true, platform: 'darwin' })).toBeNull()
    expect(updatesOffReason({ env: {}, packaged: true, platform: 'win32' })).toBeNull()
    expect(updatesOffReason({ env: {}, packaged: false, platform: 'darwin' })).toMatch(/development build/)
    expect(updatesOffReason({ env: { MASTERDECK_UPDATES: '0' }, packaged: true, platform: 'darwin' })).toMatch(/MASTERDECK_UPDATES=0/)
    expect(updatesOffReason({ env: {}, packaged: true, platform: 'linux' })).toMatch(/not available/)
    expect(updatesOffReason({ env: {}, packaged: true, platform: 'darwin', macReason: 'disk image' })).toBe('disk image')
  })
})

describe('macOS installer', () => {
  it('finds the bundle and refuses read-only places', () => {
    expect(macBundle('/Applications/MasterDeck.app/Contents/MacOS/MasterDeck')).toBe('/Applications/MasterDeck.app')
    expect(macBundle('/usr/local/bin/electron')).toBeNull()
    expect(macDisabledReason('/Applications/MasterDeck.app')).toBeNull()
    expect(macDisabledReason('/Volumes/MasterDeck 0.9.0/MasterDeck.app')).toMatch(/disk image/)
    expect(macDisabledReason('/private/var/folders/x/AppTranslocation/ABC/d/MasterDeck.app')).toMatch(/App Translocation/)
    expect(macDisabledReason(null)).toMatch(/app bundle/)
    expect(plistVersion('<dict><key>CFBundleShortVersionString</key>\n\t<string>0.10.0</string></dict>')).toBe('0.10.0')
  })

  const PLIST = (v: string) => `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`

  function mac(over: { body?: Buffer; version?: string; writable?: boolean } = {}) {
    const ran: string[][] = []
    const spawned: string[][] = []
    let quits = 0
    // ditto stands in: it unpacks a bundle with the given Info.plist version.
    const run: Run = async (cmd, args) => {
      ran.push([cmd, ...args])
      if (cmd === '/usr/bin/ditto') {
        const app = join(args[3], 'MasterDeck.app', 'Contents')
        mkdirSync(app, { recursive: true })
        writeFileSync(join(app, 'Info.plist'), PLIST(over.version ?? '0.10.0'))
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const inst = new MacInstaller({
      dir,
      bundle: '/Apps With Space/MasterDeck.app',
      arch: 'arm64',
      current: '0.9.0',
      publicKey: PUB,
      pid: 4242,
      fetch: async () => new Response(new Uint8Array(over.body ?? ZIP), { status: 200 }),
      run,
      spawnDetached: (cmd, args) => spawned.push([cmd, ...args]),
      quit: () => quits++,
      writable: () => over.writable ?? true,
    })
    return { inst, ran, spawned, quits: () => quits }
  }

  it('downloads, verifies, unpacks and stages; Restart now starts the helper and quits', async () => {
    const m = mac()
    const progress: number[] = []
    let verifying = 0
    const offer = signedOffer()
    await m.inst.prepare(offer, (p) => progress.push(p), () => verifying++)
    expect(progress[progress.length - 1]).toBe(1)
    expect(verifying).toBe(1)
    const stage = join(dir, '0.10.0', 'stage')
    expect(m.ran[0]).toEqual(['/usr/bin/ditto', '-x', '-k', join(dir, '0.10.0', offer.name), stage])
    expect(m.ran.some((r) => r[0] === '/usr/bin/xattr')).toBe(true)
    // The zip goes once unpacked.
    expect(existsSync(join(dir, '0.10.0', offer.name))).toBe(false)
    expect(m.inst.needsAdmin()).toBe(false)

    await m.inst.restart(offer)
    expect(m.quits()).toBe(1)
    const script = join(dir, 'update-helper.sh')
    expect(readFileSync(script, 'utf8')).toMatch(/^#!\/bin\/bash/)
    expect(JSON.parse(readFileSync(join(dir, 'pending.json'), 'utf8'))).toMatchObject({ version: '0.10.0', from: '0.9.0' })
    expect(m.spawned).toEqual([
      ['/bin/bash', script, 'install', '4242', '/Apps With Space/MasterDeck.app', join(stage, 'MasterDeck.app'), dir, '0.10.0', '0.9.0', '1'],
    ])
    m.inst.onQuit(offer)
    expect(m.spawned[1][m.spawned[1].length - 1]).toBe('0')
  })

  it('a bad signature is a verify error and the file is deleted', async () => {
    const m = mac()
    const offer = signedOffer({ signature: Buffer.alloc(64).toString('base64') })
    await expect(m.inst.prepare(offer, () => {}, () => {})).rejects.toMatchObject({ kind: 'verify', message: 'The release signature is not valid' })
    expect(existsSync(join(dir, '0.10.0'))).toBe(false)
    expect(m.ran).toEqual([])
  })

  it('a signature for another platform or arch does not pass', async () => {
    const m = mac()
    await expect(m.inst.prepare(signedOffer({}, 'win32', 'x64'), () => {}, () => {})).rejects.toMatchObject({ kind: 'verify' })
  })

  it('other bytes than the release are a verify error', async () => {
    const m = mac({ body: Buffer.from('something else entirely, same idea') })
    await expect(m.inst.prepare(signedOffer(), () => {}, () => {})).rejects.toMatchObject({ kind: 'verify' })
    expect(existsSync(join(dir, '0.10.0'))).toBe(false)
  })

  it('a staged app of another version is refused', async () => {
    const m = mac({ version: '0.9.5' })
    await expect(m.inst.prepare(signedOffer(), () => {}, () => {})).rejects.toMatchObject({ kind: 'verify', message: 'The update holds version 0.9.5, not 0.10.0' })
    expect(existsSync(join(dir, '0.10.0'))).toBe(false)
  })

  it('a folder that is not writable needs the password', () => {
    expect(mac({ writable: false }).inst.needsAdmin()).toBe(true)
  })

  it('the updater deletes nothing but reports verify through a real installer', async () => {
    const m = mac()
    const { u } = makeUpdater({ status: 200, body: signedOffer({ signature: Buffer.alloc(64).toString('base64') }) }, { installer: () => m.inst })
    expect(await u.check()).toMatchObject({ phase: 'error', errorKind: 'verify' })
    expect(existsSync(join(dir, '0.10.0'))).toBe(false)
  })
})

describe('Windows installer', () => {
  function fakeNsis(file: string, version = '0.10.0') {
    const seen: string[] = []
    const n: NsisLike = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowDowngrade: true,
      checkForUpdates: async () => ({ updateInfo: { version } }),
      downloadUpdate: async () => [file],
      quitAndInstall: (silent, run) => seen.push(`quitAndInstall ${silent} ${run}`),
      on: () => n,
    }
    return { n, seen }
  }
  const winOffer = () =>
    signedOffer({ name: 'MasterDeck-Setup-0.10.0.exe', url: 'https://updates.test/v1/updates/files/0.10.0/MasterDeck-Setup-0.10.0.exe' }, 'win32', 'x64')

  it('uses the per-install feed, verifies the file, then installs on quit', async () => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'setup.exe')
    writeFileSync(file, ZIP)
    const { n, seen } = fakeNsis(file)
    const feeds: string[] = []
    const w = new WinInstaller({ base: 'https://updates.test', channel: () => 'beta', id: 'abc', arch: 'x64', publicKey: PUB, make: async (f) => (feeds.push(f), n) })
    await w.prepare(winOffer(), () => {}, () => {})
    expect(feeds).toEqual([feedUrl('https://updates.test', 'beta', 'abc')])
    expect(feeds[0]).toBe('https://updates.test/v1/updates/feed/beta/abc/')
    expect(n.autoDownload).toBe(false)
    expect(n.allowDowngrade).toBe(false)
    expect(n.autoInstallOnAppQuit).toBe(true)
    await w.restart()
    expect(seen).toEqual(['quitAndInstall true true'])
  })

  it('refuses another version in the feed, and deletes a file that does not verify', async () => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'setup.exe')
    writeFileSync(file, ZIP)
    const other = new WinInstaller({ base: 'b', channel: () => 'stable', id: 'i', arch: 'x64', publicKey: PUB, make: async () => fakeNsis(file, '0.10.1').n })
    await expect(other.prepare(winOffer(), () => {}, () => {})).rejects.toMatchObject({ kind: 'download' })
    const { n } = fakeNsis(file)
    const bad = new WinInstaller({ base: 'b', channel: () => 'stable', id: 'i', arch: 'arm64', publicKey: PUB, make: async () => n })
    await expect(bad.prepare(winOffer(), () => {}, () => {})).rejects.toMatchObject({ kind: 'verify' })
    expect(existsSync(file)).toBe(false)
    expect(n.autoInstallOnAppQuit).toBe(false)
  })
})
