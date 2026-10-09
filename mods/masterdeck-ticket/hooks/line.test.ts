import { expect, test } from 'claude-code/testing'

import type { Band } from './deck'
import { segments } from './line'

const BAND: Band = {
  v: 1,
  name: 'MasterDeck-Terminal-86-mods',
  ticket: { label: '#86', ref: 'acme/tracker#86', title: 'Investigate Claude Code Mods and how MasterDeck can integrate with them', url: 'https://github.com/acme/tracker/issues/86' },
  status: 'In Dev',
  pr: { number: 90, url: 'https://github.com/acme/tracker/pull/90', state: 'OPEN', ci: 'success', threads: 2, draft: false },
  peers: [{ name: 'api-112', state: 'idle' }],
}

const text = (b: Band, cols: number, stale: number | null = null) => segments(b, cols, stale).map(s => s.text).join(' ')

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
