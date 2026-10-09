import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModOff } from './modOff'

describe('ModOff', () => {
  it('keeps the sessions switched off across a restart, and forgets ones no longer listed', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'modoff-')), 'mod-off.json')
    const a = new ModOff(file)
    expect(a.has('3fa9c1d2')).toBe(false)
    expect(a.set('3fa9c1d2', false)).toBe(true)
    expect(a.set('11111111-1111-1111-1111-111111111111', false)).toBe(true)
    expect(a.set('../x', false)).toBe(false)
    const b = new ModOff(file)
    expect(b.list()).toEqual(['11111111-1111-1111-1111-111111111111', '3fa9c1d2'])
    b.set('3fa9c1d2', true)
    b.prune(new Set(['3fa9c1d2']))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
  })

  it('reads a broken or foreign file as empty', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'modoff-')), 'mod-off.json')
    writeFileSync(file, '{')
    expect(new ModOff(file).list()).toEqual([])
    writeFileSync(file, JSON.stringify(['abc12345', 7, 'not a key']))
    expect(new ModOff(file).list()).toEqual(['abc12345'])
  })
})
