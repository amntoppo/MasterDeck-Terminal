import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModCatalog, ModOff } from './modOff'

const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), 'mods-')), name)

describe('ModOff', () => {
  it('keeps the mods switched off per session across a restart, and forgets sessions no longer listed', () => {
    const file = tmp('mod-off.json')
    const a = new ModOff(file)
    expect(a.of('3fa9c1d2')).toEqual([])
    expect(a.set('3fa9c1d2', 'token-chart', false)).toBe(true)
    expect(a.set('3fa9c1d2', 'masterdeck-ticket', false)).toBe(true)
    expect(a.set('3fa9c1d2', 'masterdeck', false)).toBe(false)
    expect(a.set('11111111-1111-1111-1111-111111111111', 'diff-x', false)).toBe(true)
    expect(a.set('../x', 'a', false)).toBe(false)
    expect(a.set('3fa9c1d2', 'bad name', false)).toBe(false)
    const b = new ModOff(file)
    expect(b.of('3fa9c1d2')).toEqual(['masterdeck-ticket', 'token-chart'])
    b.set('3fa9c1d2', 'token-chart', true)
    expect(b.of('3fa9c1d2')).toEqual(['masterdeck-ticket'])
    b.prune(new Set(['3fa9c1d2']))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '3fa9c1d2': ['masterdeck-ticket'] })
    b.set('3fa9c1d2', 'masterdeck-ticket', true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('reads older files (the one MasterDeck mod off) as every feature mod off, and a broken file as empty', () => {
    const file = tmp('mod-off.json')
    writeFileSync(file, JSON.stringify(['abc12345', 7, 'not a key']))
    const features = ['masterdeck-alerts', 'masterdeck-note', 'masterdeck-ticket']
    expect(new ModOff(file).all()).toEqual({ abc12345: features })
    writeFileSync(file, JSON.stringify({ abc12345: ['masterdeck', 'token-chart'] }))
    expect(new ModOff(file).all()).toEqual({ abc12345: [...features, 'token-chart'] })
    writeFileSync(file, '{')
    expect(new ModOff(file).all()).toEqual({})
  })
})

describe('ModCatalog', () => {
  it('keeps what it is given and drops entries it cannot read', () => {
    const file = tmp('mod-catalog.json')
    const c = new ModCatalog(file)
    expect(c.entries()).toEqual([])
    c.replace([{ name: 'token-chart', provenance: 'token-chart@acme', version: '1.0.0', tier: 'user' }])
    expect(new ModCatalog(file).entries()).toEqual([{ name: 'token-chart', provenance: 'token-chart@acme', version: '1.0.0', tier: 'user' }])
    writeFileSync(file, JSON.stringify([{ name: 'ok', provenance: 'ok@m', version: null, tier: 'user' }, { name: 3 }]))
    expect(new ModCatalog(file).entries()).toHaveLength(1)
  })
})
