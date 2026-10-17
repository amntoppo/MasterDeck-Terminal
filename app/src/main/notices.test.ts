import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTICE_KEEP_MS, NOTICE_MAX, Notices } from './notices'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-notices-'))
  file = join(dir, 'notices.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Notices', () => {
  it('adds newest first, kept on disk without a temp file, and tells', () => {
    let changes = 0
    let now = 100
    const n = new Notices(file, () => changes++, () => now)
    const a = n.add({ type: 'pr-merged', title: 'a: PR merged', body: '#1 merged.', sessionKey: 'k' })
    now = 200
    n.add({ type: 'session-finished', title: 'b finished', body: 'idle', sessionKey: null })
    expect(a?.id).toMatch(/^event:pr-merged:100:/)
    expect(n.list().map((x) => x.title)).toEqual(['b finished', 'a: PR merged'])
    expect(changes).toBe(2)
    expect(new Notices(file, () => {}, () => now).list()).toEqual(n.list())
    expect(readdirSync(dir)).toEqual(['notices.json'])
  })

  it('drops old ones and keeps at most NOTICE_MAX', () => {
    let now = 1
    const n = new Notices(file, () => {}, () => now)
    n.add({ type: 'monitor', title: 'old', body: '', sessionKey: null })
    now += NOTICE_KEEP_MS + 1
    expect(n.list()).toEqual([])
    for (let i = 0; i < NOTICE_MAX + 5; i++) n.add({ type: 'monitor', title: `n${i}`, body: '', sessionKey: null })
    expect(n.list()).toHaveLength(NOTICE_MAX)
    expect(n.list()[0].title).toBe(`n${NOTICE_MAX + 4}`)
  })

  it('cuts long text and refuses an unknown type', () => {
    const n = new Notices(file, () => {}, () => 5)
    expect(n.add({ type: 'pr-ready', title: 'x'.repeat(400), body: 'y'.repeat(3000), sessionKey: null })?.title).toHaveLength(300)
    expect(n.add({ type: 'nope' as never, title: 't', body: '', sessionKey: null })).toBeNull()
  })

  it('reads a bad file as empty, and skips bad entries', () => {
    writeFileSync(file, '{not json')
    expect(new Notices(file).list()).toEqual([])
    writeFileSync(file, JSON.stringify([{ id: 'event:pr-ready:1:0', type: 'pr-ready', title: 't', body: 'b', sessionKey: null, at: Date.now() }, { id: 'x' }]))
    expect(new Notices(file).list().map((x) => x.id)).toEqual(['event:pr-ready:1:0'])
  })
})
