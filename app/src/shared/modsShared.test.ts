import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MASTERDECK_MODS, MOD_CORE } from './modBand'

// A mod may import only its own files, so mods/shared/deck.ts is copied into each one
// (mods/sync-shared.sh). This fails while a copy differs.
const mods = new URL('../../../mods/', import.meta.url)

describe('the MasterDeck mods', () => {
  it('each carry the same copy of mods/shared/deck.ts', () => {
    const shared = readFileSync(new URL('shared/deck.ts', mods), 'utf8')
    for (const name of [MOD_CORE, ...MASTERDECK_MODS.map((m) => m.name)]) {
      expect(readFileSync(new URL(`${name}/hooks/deck.ts`, mods), 'utf8'), `${name}: run mods/sync-shared.sh`).toBe(shared)
    }
  })

  it('are the ones the marketplace lists, each under its own name', () => {
    const market = JSON.parse(readFileSync(new URL('.claude-plugin/marketplace.json', mods), 'utf8')) as { plugins: { name: string; source: string }[] }
    const names = [MOD_CORE, ...MASTERDECK_MODS.map((m) => m.name)]
    expect(market.plugins.map((p) => p.name)).toEqual(names)
    for (const name of names) {
      expect(existsSync(new URL(`${name}/.claude-plugin/plugin.json`, mods))).toBe(true)
      expect(JSON.parse(readFileSync(new URL(`${name}/.claude-plugin/plugin.json`, mods), 'utf8')).name).toBe(name)
    }
  })
})
