import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCache, saveCache } from './cache'

describe('github cache', () => {
  it('round-trips and creates the folder', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'cache-')), 'deep', 'cache.json')
    saveCache(p, { snapshot: { issues: [1] }, board: { cards: [] }, refreshedAt: 42 })
    expect(loadCache(p)).toEqual({ snapshot: { issues: [1] }, board: { cards: [] }, refreshedAt: 42 })
  })
  it('a missing or corrupt cache is empty, never an error', () => {
    const d = mkdtempSync(join(tmpdir(), 'cache-'))
    expect(loadCache(join(d, 'nope.json'))).toEqual({})
    writeFileSync(join(d, 'bad.json'), '{trunc')
    expect(loadCache(join(d, 'bad.json'))).toEqual({})
  })
})
