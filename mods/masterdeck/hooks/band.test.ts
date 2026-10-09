import { expect, test } from 'claude-code/testing'

import type { Band, SeenMod } from '../types'
import { bandEvents, isQuiet, noteAnswerText, noteRequestId, parseBand, refuses, seenWith, segments, toReload } from './band'

const BAND: Band = {
  v: 1,
  name: 'MasterDeck-Terminal-86-mods',
  ticket: { label: '#86', ref: 'acme/tracker#86', title: 'Investigate Claude Code Mods and how MasterDeck can integrate with them', url: 'https://github.com/acme/tracker/issues/86' },
  status: 'In Dev',
  pr: { number: 90, url: 'https://github.com/acme/tracker/pull/90', state: 'OPEN', ci: 'success', threads: 2, draft: false },
  peers: [{ name: 'api-112', state: 'idle' }],
}

const text = (b: Band, cols: number, stale: number | null = null) => segments(b, cols, stale).map(s => s.text).join(' ')

test('reads only a band file of this version', async () => {
  expect(parseBand(JSON.stringify(BAND))).toEqual(BAND)
  expect(parseBand(JSON.stringify({ ...BAND, v: 2 }))).toBe(null)
  expect(parseBand('{')).toBe(null)
  expect(parseBand('null')).toBe(null)
})

test('draws a short line under 90 columns and the title when there is room', async () => {
  expect(text(BAND, 80)).toBe('#86 In Dev PR #90 ✓ 2 threads')
  expect(text(BAND, 110)).toBe('#86 Investigate Claude Code Mods and how… ● In Dev PR #90 ✓ CI 2 threads 1 linked')
  expect(text(BAND, 90)).toBe('#86 Investigate Clau… ● In Dev PR #90 ✓ CI 2 threads 1 linked')
  expect(text(BAND, 75)).toBe('#86 In Dev PR #90 ✓ 2 threads')
  expect(text(BAND, 160)).toBe('#86 Investigate Claude Code Mods and how MasterDeck can integrate with them ● In Dev PR #90 ✓ CI 2 threads 1 linked')
})

test('says when MasterDeck is closed and how old the data is', async () => {
  expect(text(BAND, 120, 14 * 60_000)).toBe('#86 MasterDeck is closed · ticket data from 14 min ago')
})

test('names a session with no ticket by its name, and a merged PR as merged', async () => {
  const b: Band = { ...BAND, ticket: null, status: null, pr: { ...BAND.pr!, state: 'MERGED', threads: 0 } }
  expect(text(b, 120)).toBe('MasterDeck-Terminal-86-mods PR #90 merged 1 linked')
})

test('toasts what changed, and nothing on the first read', async () => {
  expect(bandEvents(null, BAND)).toEqual([])
  expect(bandEvents(BAND, BAND)).toEqual([])
  const next: Band = { ...BAND, status: 'In Review', pr: { ...BAND.pr!, threads: 3, ci: 'failure' } }
  expect(bandEvents(BAND, next)).toEqual(['#86 moved: In Dev → In Review', 'PR #90: 1 new review thread', 'PR #90: CI failed'])
  expect(bandEvents(next, { ...next, pr: { ...next.pr!, ci: 'success', state: 'MERGED' } })).toEqual(['PR #90: CI passed', 'PR #90 merged'])
  expect(bandEvents({ ...BAND, pr: null }, BAND)).toEqual(['PR #90 is linked to this session'])
  // Switched off, or just switched back on: nothing to toast.
  expect(bandEvents(BAND, { ...next, offMods: ['masterdeck'] })).toEqual([])
  expect(bandEvents({ ...BAND, offMods: ['masterdeck'] }, next)).toEqual([])
  // Another mod switched off: this one still toasts.
  expect(bandEvents({ ...BAND, offMods: ['other'] }, { ...next, offMods: ['other'] })).toHaveLength(3)
})

test('refuses only an installed mod switched off here, never itself or a built-in one', async () => {
  expect(isQuiet({ ...BAND, offMods: ['masterdeck'] })).toBe(true)
  expect(isQuiet({ ...BAND, offMods: ['other'] })).toBe(false)
  expect(isQuiet(null)).toBe(false)
  expect(refuses({ name: 'other', tier: 'user' }, ['other'])).toBe(true)
  expect(refuses({ name: 'other', tier: 'user' }, [])).toBe(false)
  expect(refuses({ name: 'masterdeck', tier: 'user' }, ['masterdeck'])).toBe(false)
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

test('makes request ids the app takes, and reads its answers', async () => {
  expect(/^[0-9]+-[0-9]+-[0-9]+$/.test(noteRequestId(1_791_578_586_510, 0.5))).toBe(true)
  expect(noteAnswerText(JSON.stringify({ ok: true, message: 'Added to the note of acme/tracker#86.' }))).toBe('Added to the note of acme/tracker#86.')
  expect(noteAnswerText(JSON.stringify({ ok: false, error: 'The text is too long for a note.' }))).toBe('Not saved: The text is too long for a note.')
  expect(noteAnswerText('?')).toBe('MasterDeck answered something this mod cannot read; look in Notes.')
})
