import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readNewLines, readToEnd, type FollowState } from './files'

describe('readNewLines', () => {
  it('returns only complete new lines and carries a partial one', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'follow-')), 't.jsonl')
    writeFileSync(p, 'a\nb\npart')
    const st: FollowState = { path: p, offset: 0, rest: '' }
    expect(readNewLines(st)).toEqual(['a', 'b'])
    expect(readNewLines(st)).toEqual([])
    appendFileSync(p, 'ial\nc\n')
    expect(readNewLines(st)).toEqual(['partial', 'c'])
  })
  it('starts near the end of a big file and restarts when the file shrinks', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'follow-')), 't.jsonl')
    writeFileSync(p, 'x'.repeat(100) + '\nlast\n')
    const st: FollowState = { path: p, offset: 0, rest: '' }
    // 106 bytes, firstMax 10: starts at byte 96, inside the long line.
    expect(readNewLines(st, 10)).toEqual(['xxxx', 'last'])
    writeFileSync(p, 'new\n')
    expect(readNewLines(st, 10)).toEqual(['new'])
  })
  it('returns nothing for a missing file', () => {
    expect(readNewLines({ path: '/nope/x', offset: 0, rest: '' })).toEqual([])
  })
})

describe('readNewLines from the start', () => {
  it('reads a whole file when asked, not just its last part', () => {
    const d = mkdtempSync(join(tmpdir(), 'rnl-'))
    const p = join(d, 't.jsonl')
    writeFileSync(p, 'first\n' + 'x'.repeat(100) + '\nlast\n')
    const tailOnly = readNewLines({ path: p, offset: 0, rest: '' }, 20)
    expect(tailOnly).not.toContain('first')
    const all = readNewLines({ path: p, offset: 0, rest: '' }, Infinity)
    expect(all[0]).toBe('first')
    expect(all).toContain('last')
  })
})

describe('readToEnd', () => {
  it('reads a file bigger than one chunk to its last line in one call (#158)', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'follow-')), 't.jsonl')
    // Past the 8 MB a readNewLines call gives: the line at the end is the session's latest reply.
    writeFileSync(p, `${'x'.repeat(1023)}\n`.repeat(9 * 1024) + 'reply\n')
    const st: FollowState = { path: p, offset: 0, rest: '' }
    const seen: string[] = []
    readToEnd(st, 16 * 1024 * 1024, (lines) => seen.push(...lines))
    expect(seen[seen.length - 1]).toBe('reply')
    expect(seen).toHaveLength(9 * 1024 + 1)
    // With a small chunk too, and nothing more once at the end.
    const small: FollowState = { path: p, offset: 0, rest: '' }
    let calls = 0
    readToEnd(small, Infinity, () => calls++, 1024 * 1024)
    expect(calls).toBe(10)
    readToEnd(small, Infinity, () => calls++)
    expect(calls).toBe(10)
    readToEnd({ path: '/nope/x', offset: 0, rest: '' }, 10, () => calls++)
    expect(calls).toBe(10)
  })
})
