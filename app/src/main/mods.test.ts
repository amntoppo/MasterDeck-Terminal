import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MODS_CORE } from '@shared/mods'
import { hashMods, managedSettingsFiles, modNames, ModsInstaller, modsVersion, syncModsFolder } from './mods'
import type { Runner, RunResult } from './run'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-mods-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

/** A bundled mods folder like the repository's mods/: two mods, tests and the shared source beside them. */
function bundle(version = '0.5.0'): string {
  const b = join(dir, 'bundled')
  put(join(b, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'masterdeck', plugins: [{ name: 'masterdeck', source: './masterdeck' }, { name: 'masterdeck-ticket', source: './masterdeck-ticket' }] }))
  put(join(b, 'masterdeck', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'masterdeck', version }))
  put(join(b, 'masterdeck', 'hooks', 'core.ts'), `export const v = '${version}'`)
  put(join(b, 'masterdeck', 'hooks', 'core.test.ts'), 'test')
  put(join(b, 'masterdeck-ticket', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'masterdeck-ticket', version }))
  put(join(b, 'shared', 'deck.ts'), 'shared')
  put(join(b, 'sync-shared.sh'), '#!/bin/bash')
  return b
}

describe('syncModsFolder', () => {
  it('copies the mods without tests or the shared source, then leaves an unchanged folder alone', () => {
    const b = bundle()
    const dest = join(dir, 'home', 'mods')
    expect(syncModsFolder(b, dest)).toEqual({ changed: true })
    expect(existsSync(join(dest, 'masterdeck', 'hooks', 'core.ts'))).toBe(true)
    expect(existsSync(join(dest, 'masterdeck', 'hooks', 'core.test.ts'))).toBe(false)
    expect(existsSync(join(dest, 'shared'))).toBe(false)
    expect(existsSync(join(dest, 'sync-shared.sh'))).toBe(false)
    expect(json(join(dest, '.masterdeck-mods.json'))).toEqual({ hash: hashMods(b), version: '0.5.0' })
    expect(syncModsFolder(b, dest)).toEqual({ changed: false })
    expect(readdirSync(join(dir, 'home'))).toEqual(['mods'])
  })
  it('an update replaces the folder (a file the old version had is gone)', () => {
    const b = bundle()
    const dest = join(dir, 'mods')
    syncModsFolder(b, dest)
    put(join(dest, 'masterdeck', 'stale.ts'), 'old')
    put(join(b, 'masterdeck', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'masterdeck', version: '0.6.0' }))
    expect(syncModsFolder(b, dest)).toEqual({ changed: true })
    expect(modsVersion(dest)).toBe('0.6.0')
    expect(existsSync(join(dest, 'masterdeck', 'stale.ts'))).toBe(false)
  })
  it('a hand copy without the marker is replaced', () => {
    const b = bundle()
    const dest = join(dir, 'mods')
    put(join(dest, 'masterdeck', '.claude-plugin', 'plugin.json'), '{"version":"0.1.0"}')
    expect(syncModsFolder(b, dest).changed).toBe(true)
    expect(modsVersion(dest)).toBe('0.5.0')
  })
  it('says so when the build has no mods', () => {
    expect(syncModsFolder(join(dir, 'nothing'), join(dir, 'mods'))).toMatchObject({ changed: false, error: expect.stringMatching(/no mods/) })
  })
})

it('modNames lists the marketplace, in order', () => {
  expect(modNames(bundle())).toEqual(['masterdeck', 'masterdeck-ticket'])
  expect(modNames(join(dir, 'none'))).toEqual([])
})

it('managedSettingsFiles names each platform\'s file', () => {
  expect(managedSettingsFiles('darwin')[0]).toBe(join('/Library/Application Support/ClaudeCode', 'managed-settings.json'))
  expect(managedSettingsFiles('linux')[0]).toBe(join('/etc/claude-code', 'managed-settings.json'))
})

/** A stand-in claude: `plugin …` edits settings.json as Claude Code 2.1.296 does, with its --json lines. */
function fakeClaude(settings: string, opts: { version?: string; fail?: string; subscription?: string } = {}) {
  const calls: string[][] = []
  const read = () => (existsSync(settings) ? json(settings) : {})
  const save = (s: Record<string, unknown>) => writeFileSync(settings, JSON.stringify(s))
  const out = (o: Record<string, unknown>, code = 0): RunResult => ({ code, stdout: JSON.stringify(o) + '\n', stderr: '' })
  const run: Runner = async (_cmd, args) => {
    calls.push(args)
    if (args[0] === '--version') return { code: 0, stdout: `${opts.version ?? '2.1.296'} (Claude Code)\n`, stderr: '' }
    if (args[0] === 'auth') return out({ loggedIn: true, subscriptionType: opts.subscription ?? 'max' })
    const what = args.slice(1, 3).join(' ')
    if (opts.fail && args.join(' ').includes(opts.fail)) return out({ outcome: 'failed', message: `${opts.fail} broke` }, 1)
    const s = read()
    if (what.startsWith('marketplace add')) {
      s.extraKnownMarketplaces = { ...s.extraKnownMarketplaces, masterdeck: { source: { source: 'directory', path: args[3] } } }
    } else if (args[1] === 'install') {
      s.enabledPlugins = { ...s.enabledPlugins, [args[2]]: true }
    } else if (args[1] === 'uninstall') {
      if (!s.enabledPlugins?.[args[2]]) return out({ outcome: 'failed', failureCode: 'not_installed', message: 'not found' }, 1)
      delete s.enabledPlugins[args[2]]
    } else if (what.startsWith('marketplace remove')) {
      if (!s.extraKnownMarketplaces?.masterdeck) return out({ outcome: 'failed', failureCode: 'not_configured', message: 'not found' }, 1)
      delete s.extraKnownMarketplaces.masterdeck
    }
    save(s)
    return out({ outcome: 'ok' })
  }
  return { run, calls }
}

function installer(o: Parameters<typeof fakeClaude>[1] & { managed?: Record<string, unknown> } = {}) {
  const settings = join(dir, 'claude', 'settings.json')
  put(settings, JSON.stringify({ theme: 'dark', prependPlugins: ['other@x'] }))
  const fake = fakeClaude(settings, o)
  const managed = join(dir, 'managed.json')
  if (o.managed) put(managed, JSON.stringify(o.managed))
  const home = join(dir, 'home')
  const m = new ModsInstaller({
    run: fake.run,
    claude: () => 'claude',
    bundled: bundle(),
    folder: join(home, 'mods'),
    settings,
    refused: null,
    backupDir: home,
    installedFile: join(home, 'mods-installed.json'),
    managedFiles: [managed],
    now: () => 4242,
  })
  const backups = () => (existsSync(home) ? readdirSync(home).filter((f) => f.startsWith('settings.backup.')) : [])
  return { m, settings, home, fake, backups }
}

describe('ModsInstaller', () => {
  it('install: folder, marketplace, every mod, the core first in prependPlugins, backups before', async () => {
    const { m, settings, home, fake, backups } = installer()
    const r = await m.install()
    expect(r).toMatchObject({ ok: true })
    const s = json(settings)
    expect(s.theme).toBe('dark')
    expect(s.prependPlugins).toEqual([MODS_CORE, 'other@x'])
    expect(s.enabledPlugins).toEqual({ 'masterdeck@masterdeck': true, 'masterdeck-ticket@masterdeck': true })
    expect(s.extraKnownMarketplaces.masterdeck.source.path).toBe(join(home, 'mods'))
    expect(fake.calls.filter((c) => c[0] === 'plugin').map((c) => c.slice(1, 3).join(' '))).toEqual([
      `marketplace add`,
      'install masterdeck@masterdeck',
      'install masterdeck-ticket@masterdeck',
    ])
    expect(fake.calls.every((c) => c[0] !== 'plugin' || (c.includes('--json') && (c.includes('user') || c[1] === 'marketplace')))).toBe(true)
    // One before the CLI, one before MasterDeck's own write; the first is the original file.
    expect(backups().length).toBe(2)
    expect(json(join(home, backups().find((f) => f.includes('before-mods'))!))).toEqual({ theme: 'dark', prependPlugins: ['other@x'] })
    expect(m.installedAt()).toBe(4242)
    expect(m.status()).toMatchObject({ state: 'installed', claude: '2.1.296', version: '0.5.0', prependNote: null, unavailable: null })
  })

  it('uninstall: every mod, the marketplace and the core out of prependPlugins; the rest kept', async () => {
    const { m, settings, backups } = installer()
    await m.install()
    const before = backups().length
    const r = await m.uninstall()
    expect(r).toMatchObject({ ok: true })
    const s = json(settings)
    expect(s.prependPlugins).toEqual(['other@x'])
    expect(s.enabledPlugins).toEqual({})
    expect(s.extraKnownMarketplaces).toEqual({})
    expect(s.theme).toBe('dark')
    expect(backups().length).toBe(before + 2)
    expect(m.installedAt()).toBeNull()
    expect(m.status().state).toBe('off')
  })

  it('uninstall of what is not there is fine (not_installed, not_configured)', async () => {
    const { m } = installer()
    expect(await m.uninstall()).toMatchObject({ ok: true })
  })

  it('refuses an older Claude Code before changing anything', async () => {
    const { m, settings, fake, backups } = installer({ version: '2.1.200' })
    const r = await m.install()
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/2\.1\.287 or later; this Mac has 2\.1\.200/) })
    expect(fake.calls.some((c) => c[0] === 'plugin')).toBe(false)
    expect(json(settings)).toEqual({ theme: 'dark', prependPlugins: ['other@x'] })
    expect(backups()).toEqual([])
  })

  it('stops at a failed step and says which; prependPlugins is not added', async () => {
    const { m, settings } = installer({ fail: 'install masterdeck-ticket' })
    const r = await m.install()
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/install masterdeck-ticket@masterdeck.*broke/) })
    expect(json(settings).prependPlugins).toEqual(['other@x'])
    expect(m.status()).toMatchObject({ state: 'partial', missing: ['masterdeck-ticket', 'prependPlugins'] })
  })

  it('refused without a settings file of its own (an isolated app)', async () => {
    const m = new ModsInstaller({
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      claude: () => 'claude',
      bundled: bundle(),
      folder: join(dir, 'mods'),
      settings: null,
      refused: 'kept apart',
      backupDir: dir,
      installedFile: join(dir, 'i.json'),
      managedFiles: [],
    })
    expect(await m.install()).toEqual({ ok: false, message: 'kept apart' })
    expect(m.status().unavailable).toBe('kept apart')
  })

  it('says when prependPlugins is ignored: managed settings, a Team plan', async () => {
    const managed = installer({ managed: { allowManagedHooksOnly: false } })
    await managed.m.refresh()
    expect(managed.m.status().prependNote).toMatch(/managed settings/)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir)
    const team = installer({ subscription: 'team' })
    await team.m.refresh()
    expect(team.m.status().prependNote).toMatch(/Team or Enterprise/)
  })

  it('one change at a time', async () => {
    const { m } = installer()
    const [a, b] = await Promise.all([m.install(), m.install()])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect([a, b].find((x) => !x.ok)?.message).toMatch(/already changing/)
  })
})
