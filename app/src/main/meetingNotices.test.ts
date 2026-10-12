import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MeetingNotices } from './meetingNotices'

const A = 'm-' + 'a'.repeat(32)
const B = 'm-' + 'b'.repeat(32)
let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-notices-'))
  file = join(dir, 'meeting-notices.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('MeetingNotices', () => {
  it('one per meeting, kept on disk (no temp file left), cleared by kind or all', () => {
    let changes = 0
    const n = new MeetingNotices(file, () => changes++, () => 10)
    n.set({ meetingId: A, title: 'Standup', at: 5, kind: 'failed', reason: 'Transcription failed: x' })
    n.set({ meetingId: A, title: 'Standup', at: 6, kind: 'added', sessions: 2, tickets: 0 })
    n.set({ meetingId: B, title: 'Sync', at: 7, kind: 'unmatched', reason: 'no answer' })
    expect(n.list().map((x) => [x.meetingId, x.kind])).toEqual([[B, 'unmatched'], [A, 'added']])
    expect(new MeetingNotices(file, () => {}, () => 10).list()).toEqual(n.list())
    expect(readdirSync(dir)).toEqual(['meeting-notices.json'])
    expect(n.clear(A, 'failed')).toBe(false)
    expect(n.clear(A, 'added')).toBe(true)
    expect(n.clear(B)).toBe(true)
    expect(n.list()).toEqual([])
    expect(changes).toBe(5)
  })

  it('the same notice again changes nothing; a bad one is not kept', () => {
    let changes = 0
    const n = new MeetingNotices(file, () => changes++, () => 10)
    n.set({ meetingId: A, title: 'x', at: 5, kind: 'failed', reason: 'r' })
    n.set({ meetingId: A, title: 'x', at: 9, kind: 'failed', reason: 'r' })
    expect(changes).toBe(1)
    expect(n.list()[0]!.at).toBe(5)
    n.set({ meetingId: '../x', title: 'x', at: 5, kind: 'failed', reason: 'r' })
    n.set({ meetingId: B, title: 'a\nb', at: 5, kind: 'failed', reason: 'r' })
    n.set({ meetingId: B, title: 'x', at: 5, kind: 'added', sessions: -1, tickets: 0 })
    expect(n.list()).toHaveLength(1)
  })

  it('a file that is not ours reads as none; old items go after 30 days', () => {
    writeFileSync(file, '{"not": "a list"}')
    expect(new MeetingNotices(file).list()).toEqual([])
    writeFileSync(file, JSON.stringify([{ meetingId: A, title: 'x', at: 1, kind: 'added', sessions: 1, tickets: 0 }, { meetingId: 'bad' }]))
    expect(new MeetingNotices(file, () => {}, () => 2).list()).toHaveLength(1)
    expect(new MeetingNotices(file, () => {}, () => 31 * 86_400_000).list()).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2)
  })
})
