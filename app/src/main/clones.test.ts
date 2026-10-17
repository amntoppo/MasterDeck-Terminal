import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CloneStore } from './clones'

const dirs: string[] = []
const fileIn = () => {
  const d = mkdtempSync(join(tmpdir(), 'md-clones-'))
  dirs.push(d)
  return join(d, 'session-clones.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const rec = (at = 1000) => ({ from: { key: 'a0cd01ba', name: 'orig' }, at, branch: 'main' })
const row = (o: { bgId: string; name: string; startedAt: number; state?: 'idle' | 'done' }) => ({ kind: 'background' as const, state: 'idle' as const, ...o })

describe('CloneStore', () => {
  it('writes atomically and reads back, also from a second instance', () => {
    const f = fileIn()
    const a = new CloneStore(f)
    a.add('83c38441', rec())
    expect(new CloneStore(f).get('83c38441')).toEqual(rec())
    expect(JSON.parse(readFileSync(f, 'utf8'))['83c38441'].from.name).toBe('orig')
    expect(a.get(null)).toBeNull()
  })

  it('claims a clone by name once a newer background session of that name is listed', () => {
    const s = new CloneStore(fileIn())
    s.expect('orig (clone)', rec(20_000))
    s.claim([row({ bgId: 'aaaaaaaa', name: 'orig (clone)', startedAt: 0 })], 20_000)
    expect(s.get('aaaaaaaa')).toBeNull() // an older one of that name
    s.claim([row({ bgId: 'bbbbbbbb', name: 'orig (clone)', startedAt: 21_000 })], 21_000)
    expect(s.get('bbbbbbbb')?.from.name).toBe('orig')
  })

  it('gives up on a name after ten minutes', () => {
    const s = new CloneStore(fileIn())
    s.expect('x', rec(0))
    s.claim([], 11 * 60_000)
    s.claim([row({ bgId: 'cccccccc', name: 'x', startedAt: 5 })], 11 * 60_000)
    expect(s.get('cccccccc')).toBeNull()
  })

  it('lists kept ticket links until they are marked linked', () => {
    const s = new CloneStore(fileIn())
    s.add('dddddddd', { ...rec(), ticket: { repo: null, number: 7 } })
    s.add('eeeeeeee', rec())
    expect(s.toLink().map(([bg]) => bg)).toEqual(['dddddddd'])
    s.markLinked('dddddddd')
    expect(s.toLink()).toEqual([])
    expect(s.get('dddddddd')?.linked).toBe(true)
  })

  it('reads an unreadable file as empty', () => {
    const f = fileIn()
    writeFileSync(f, '{nope')
    expect(new CloneStore(f).get('83c38441')).toBeNull()
  })
})
