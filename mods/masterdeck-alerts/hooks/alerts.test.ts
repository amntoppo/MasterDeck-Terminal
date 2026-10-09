import { expect, test } from 'claude-code/testing'

import { bandEvents } from './alerts'
import type { Band } from './deck'

const BAND: Band = {
  v: 1,
  name: 'MasterDeck-Terminal-86-mods',
  ticket: { label: '#86', ref: 'acme/tracker#86', title: 'Mods', url: 'https://github.com/acme/tracker/issues/86' },
  status: 'In Dev',
  pr: { number: 90, url: 'https://github.com/acme/tracker/pull/90', state: 'OPEN', ci: 'success', threads: 2, draft: false },
  peers: [],
}

test('toasts what changed, and nothing on the first read or while switched off', async () => {
  expect(bandEvents(null, BAND)).toEqual([])
  expect(bandEvents(BAND, BAND)).toEqual([])
  const next: Band = { ...BAND, status: 'In Review', pr: { ...BAND.pr!, threads: 3, ci: 'failure' } }
  expect(bandEvents(BAND, next)).toEqual(['#86 moved: In Dev → In Review', 'PR #90: 1 new review thread', 'PR #90: CI failed'])
  expect(bandEvents(next, { ...next, pr: { ...next.pr!, ci: 'success', state: 'MERGED' } })).toEqual(['PR #90: CI passed', 'PR #90 merged'])
  expect(bandEvents({ ...BAND, pr: null }, BAND)).toEqual(['PR #90 is linked to this session'])
  // The mod passes null while it is off: switching it on again toasts nothing.
  expect(bandEvents(null, next)).toEqual([])
})
