import { describe, expect, it } from 'vitest'
import { MASTERDECK_MODS, MOD_VERSION } from './modBand'
import {
  claudeRefusal,
  MODS_CORE,
  modsInSettings,
  modsReloadOffer,
  modsReloadText,
  parseClaudeVersion,
  prependNote,
  versionAtLeast,
  withPrepend,
} from './mods'
import type { Session } from './types'

const NAMES = ['masterdeck', 'masterdeck-ticket']
const FOLDER = '/home/u/.claude/masterdeck/mods'
const full = {
  extraKnownMarketplaces: { masterdeck: { source: { source: 'directory', path: FOLDER } } },
  enabledPlugins: { 'masterdeck@masterdeck': true, 'masterdeck-ticket@masterdeck': true },
  prependPlugins: [MODS_CORE],
}

describe('Claude Code version', () => {
  it('reads the version claude --version prints', () => {
    expect(parseClaudeVersion('2.1.296 (Claude Code)\n')).toBe('2.1.296')
    expect(parseClaudeVersion('command not found')).toBeNull()
  })
  it('compares dotted numbers, not strings', () => {
    expect(versionAtLeast('2.1.287', '2.1.287')).toBe(true)
    expect(versionAtLeast('2.1.1000', '2.1.287')).toBe(true)
    expect(versionAtLeast('2.1.29', '2.1.287')).toBe(false)
    expect(versionAtLeast('3.0.0', '2.9.999')).toBe(true)
  })
  it('refuses a missing or older Claude Code', () => {
    expect(claudeRefusal(null)).toMatch(/not found/)
    expect(claudeRefusal('2.1.286')).toMatch(/2\.1\.287 or later; this Mac has 2\.1\.286/)
    expect(claudeRefusal('2.1.296')).toBeNull()
  })
})

describe('modsInSettings', () => {
  it('installed: the marketplace on this folder, every mod on, the core prepended', () => {
    expect(modsInSettings(full, FOLDER, NAMES)).toEqual({ state: 'installed', missing: [] })
    expect(modsInSettings(full, `${FOLDER}/`, NAMES).state).toBe('installed')
  })
  it('off: none of it', () => {
    expect(modsInSettings({}, FOLDER, NAMES)).toEqual({ state: 'off', missing: ['marketplace', ...NAMES, 'prependPlugins'] })
  })
  it('partial: says what is missing (a mod switched off, no prependPlugins, another folder)', () => {
    const s = {
      ...full,
      extraKnownMarketplaces: { masterdeck: { source: { source: 'directory', path: '/elsewhere/mods' } } },
      enabledPlugins: { 'masterdeck@masterdeck': true, 'masterdeck-ticket@masterdeck': false },
      prependPlugins: ['other@x'],
    }
    expect(modsInSettings(s, FOLDER, NAMES)).toEqual({ state: 'partial', missing: ['marketplace', 'masterdeck-ticket', 'prependPlugins'] })
  })
})

describe('withPrepend', () => {
  it('puts the core first and keeps the rest', () => {
    expect(withPrepend({ theme: 'dark', prependPlugins: ['a@b', MODS_CORE] }, true)).toEqual({ theme: 'dark', prependPlugins: [MODS_CORE, 'a@b'] })
    expect(withPrepend({}, true)).toEqual({ prependPlugins: [MODS_CORE] })
  })
  it('takes it out, and the key when nothing is left', () => {
    expect(withPrepend({ prependPlugins: [MODS_CORE] }, false)).toEqual({})
    expect(withPrepend({ prependPlugins: [MODS_CORE, 'a@b'] }, false)).toEqual({ prependPlugins: ['a@b'] })
  })
  it('null when nothing changes (no needless write)', () => {
    expect(withPrepend({ prependPlugins: [MODS_CORE, 'a@b'] }, true)).toBeNull()
    expect(withPrepend({}, false)).toBeNull()
    expect(withPrepend({ prependPlugins: ['a@b'] }, false)).toBeNull()
  })
})

describe('prependNote', () => {
  it('managed settings that do not list the core', () => {
    expect(prependNote({ managed: true, managedPrepends: false, subscription: 'max' })).toMatch(/managed settings/)
    expect(prependNote({ managed: true, managedPrepends: true, subscription: 'enterprise' })).toBeNull()
  })
  it('a Team or Enterprise sign-in', () => {
    expect(prependNote({ managed: false, managedPrepends: false, subscription: 'team' })).toMatch(/Team or Enterprise/)
    expect(prependNote({ managed: false, managedPrepends: false, subscription: 'Enterprise' })).toMatch(/Team or Enterprise/)
    expect(prependNote({ managed: false, managedPrepends: false, subscription: 'max' })).toBeNull()
    expect(prependNote({ managed: false, managedPrepends: false, subscription: null })).toBeNull()
  })
})

const session = (key: string, state: Session['state'], startedAt = 1000, extra: Partial<Session> = {}): Session => ({
  key,
  sessionId: `sid-${key}`,
  name: key,
  kind: 'background',
  bgId: key,
  pid: null,
  cwd: '/w',
  state,
  rawState: state,
  startedAt,
  issue: null,
  ...extra,
})
const beat = (version: string) => ({ version, mods: MASTERDECK_MODS.map((m) => ({ name: m.name, provenance: `${m.name}@masterdeck`, version, tier: 'user', loaded: true })) })

describe('modsReloadOffer', () => {
  it('sessions whose core is older, and only idle ones can reload now', () => {
    const ss = [session('a', 'idle'), session('b', 'working'), session('c', 'idle'), session('d', 'needs-input')]
    const beats = { 'sid-a': beat('0.1.0'), 'sid-b': beat('0.1.0'), 'sid-c': beat(MOD_VERSION), 'sid-d': beat('0.1.0') }
    expect(modsReloadOffer(ss, beats, true, null)).toEqual({ keys: ['a', 'b', 'd'], idle: ['a'] })
  })
  it('no heartbeat: only sessions started before MasterDeck installed the mods', () => {
    const ss = [session('old', 'idle', 1000), session('new', 'idle', 5000)]
    expect(modsReloadOffer(ss, {}, true, 2000)).toEqual({ keys: ['old'], idle: ['old'] })
    expect(modsReloadOffer(ss, {}, true, null)).toBeNull()
  })
  it('nothing when the mods are not installed, or for ended and suspended sessions', () => {
    const beats = { 'sid-a': beat('0.1.0') }
    expect(modsReloadOffer([session('a', 'idle')], beats, false, null)).toBeNull()
    expect(modsReloadOffer([session('a', 'done'), session('b', 'suspended')], { ...beats, 'sid-b': beat('0.1.0') }, true, null)).toBeNull()
  })
  it('an idle session with background work running is not typed into', () => {
    expect(modsReloadOffer([session('a', 'idle', 1000, { busyWith: 'an agent' })], { 'sid-a': beat('0.1.0') }, true, null)).toEqual({ keys: ['a'], idle: [] })
  })
  it('says how many and what to do', () => {
    expect(modsReloadText({ keys: ['a'], idle: ['a'] })).toMatch(/^1 running session still uses .* It is idle: reload it now\.$/)
    expect(modsReloadText({ keys: ['a', 'b'], idle: [] })).toMatch(/None is idle now: they take the new mods/)
    expect(modsReloadText({ keys: ['a', 'b', 'c'], idle: ['a'] })).toMatch(/1 is idle and can reload now; the others/)
  })
})
