import { describe, expect, it } from 'vitest'
import { WEB_ANSWER_MAX, webFit, type ChangeList, type DiffRead, type FileList, type FileRead } from './sessionFiles'

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

describe('webFit', () => {
  it('passes small answers as they are', () => {
    const r: FileRead = { ok: true, path: 'a', text: 'hi', refused: null, bytes: 2, mtimeMs: 1 }
    expect(webFit(r)).toBe(r)
    const f: { ok: false; message: string } = { ok: false, message: 'x' }
    expect(webFit(f)).toBe(f)
  })
  it('turns a file too big for the bridge into too-large', () => {
    // Quotes are escaped in JSON: a 600 KB file of them is 1.2 MB on the wire.
    const r: FileRead = { ok: true, path: 'a', text: '"'.repeat(600_000), refused: null, bytes: 600_000, mtimeMs: 1 }
    expect(webFit(r)).toEqual({ ok: true, path: 'a', text: null, refused: 'too-large', bytes: 600_000, mtimeMs: 1 })
  })
  it('cuts a long file list to fit and says so', () => {
    const paths = Array.from({ length: 50_000 }, (_, i) => `some/long/folder/name/that/repeats/file-${i}.ts`)
    const r = webFit({ ok: true, paths, truncated: false } as FileList)
    expect(r.ok && r.truncated).toBe(true)
    expect(size(r)).toBeLessThanOrEqual(WEB_ANSWER_MAX)
    expect(r.ok && r.paths[0]).toBe(paths[0])
  })
  it('cuts a long change list until it fits', () => {
    const files = Array.from({ length: 5000 }, (_, i) => ({ path: `${'deep/'.repeat(40)}file-${i}.ts`, status: 'added' as const, add: 1, del: 0, binary: false }))
    const r = webFit({ ok: true, files } as ChangeList)
    expect(size(r)).toBeLessThanOrEqual(WEB_ANSWER_MAX)
    expect(r.ok && r.files.length).toBeGreaterThan(0)
    expect(r.ok && r.more).toBe(5000 - (r.ok ? r.files.length : 0))
  })
  it('refuses a diff too big for the bridge', () => {
    const line = { kind: 'add' as const, text: 'x'.repeat(1000), new: 1 }
    const d: DiffRead = { ok: true, path: 'a', diff: { binary: false, truncated: false, hunks: [{ header: '@@', lines: Array(2000).fill(line) }] } }
    expect(webFit(d)).toEqual({ ok: false, message: 'This diff is too large to show in the browser. Open it on the Mac.' })
  })
})
