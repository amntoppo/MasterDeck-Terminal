import { expect, test } from 'claude-code/testing'

import type { SeenMod } from '../types'
import { refuses, seenWith, toReload } from './core'
import { ago, deckFolder, deckRead, isOff, parseBand } from './deck'

const BAND = { v: 1, name: 's', ticket: null, status: null, pr: null, peers: [] }

test('reads only a band file of this version, and each mod its own switch', async () => {
  expect(parseBand(JSON.stringify(BAND))).toEqual(BAND)
  expect(parseBand(JSON.stringify({ ...BAND, v: 2 }))).toBe(null)
  expect(parseBand('{')).toBe(null)
  expect(parseBand('null')).toBe(null)
  const band = { ...BAND, v: 1 as const, offMods: ['masterdeck-alerts'] }
  expect(isOff(band, 'masterdeck-alerts')).toBe(true)
  expect(isOff(band, 'masterdeck-ticket')).toBe(false)
  expect(isOff(null, 'masterdeck-ticket')).toBe(false)
  expect([ago(5_000), ago(14 * 60_000), ago(3 * 3_600_000)]).toEqual(['just now', '14 min ago', '3 h ago'])
})

test('finds the deck folder and says whether MasterDeck runs', async () => {
  expect(deckFolder(undefined, '/Users/me')).toBe('/Users/me/.claude/masterdeck/deck')
  expect(deckFolder('/tmp/md', '/Users/me')).toBe('/tmp/md/deck')
  const now = 1_000_000
  expect(deckRead(now - 5_000, now, JSON.stringify(BAND))).toEqual({ band: BAND, isOffline: false, lastAliveAt: 0 })
  expect(deckRead(now - 60_000, now, JSON.stringify(BAND))).toEqual({ band: BAND, isOffline: true, lastAliveAt: now - 60_000 })
  expect(deckRead(null, now, JSON.stringify(BAND))).toEqual({ band: null, isOffline: true, lastAliveAt: 0 })
  expect(deckRead(now, now, null).band).toBe(null)
})

test('refuses only an installed mod switched off here, never MasterDeck\'s own, a managed or a built-in one', async () => {
  expect(refuses({ name: 'other', tier: 'user' }, ['other'])).toBe(true)
  expect(refuses({ name: 'other', tier: 'user' }, [])).toBe(false)
  expect(refuses({ name: 'masterdeck-ticket', tier: 'user' }, ['masterdeck-ticket'])).toBe(false)
  expect(refuses({ name: 'masterdeck', tier: 'prepend' }, ['masterdeck'])).toBe(false)
  expect(refuses({ name: 'diff', tier: 'builtin' }, ['diff'])).toBe(false)
  expect(refuses({ name: 'guard', tier: 'prepend' }, ['guard'])).toBe(false)
})

test('keeps one entry per mod and asks for a reload once when a refused one is switched on', async () => {
  const a: SeenMod = { name: 'a', provenance: 'a@m', version: '1', tier: 'user', loaded: false }
  const list = seenWith(seenWith([], a), { ...a, version: '2' })
  expect(list).toEqual([{ ...a, version: '2' }])
  expect(toReload(list, ['a'], new Set())).toEqual([])
  expect(toReload(list, [], new Set())).toEqual(['a'])
  expect(toReload(list, [], new Set(['a']))).toEqual([])
  expect(toReload([{ ...a, loaded: true }], [], new Set())).toEqual([])
})
