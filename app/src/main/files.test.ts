import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readNewLines, type FollowState } from './files'

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
