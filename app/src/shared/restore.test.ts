import { describe, expect, it } from 'vitest'
import { nextRestore, parseRestoreFile, runningNow, sameBoot } from './restore'
import type { Session } from './types'

const s = (p: Partial<Session>): Session => ({
  key: p.bgId ?? p.sessionId ?? 'k', sessionId: 'id', name: 'n', kind: 'background', bgId: 'b', pid: 100, cwd: '/w',
  state: 'working', rawState: 'running', startedAt: 0, issue: null, ...p,
})
const BOOT = 1_790_000_000_000
const NOW = BOOT + 3_600_000

describe('restore after a restart', () => {
  it('counts only background sessions with a process, never master', () => {
    const got = runningNow([
      s({ sessionId: 'a', bgId: 'a1', name: '1-x', issue: 1 }),
      s({ sessionId: 'b', pid: null, state: 'needs-input' }), // killed, still says blocked
      s({ sessionId: 'c', kind: 'interactive', bgId: null }),
      s({ sessionId: 'd', name: 'master-agent' }),
      s({ sessionId: 'e', state: 'done' }),
    ], 'master-agent')
    expect(got).toEqual([{ sessionId: 'a', bgId: 'a1', name: '1-x', cwd: '/w', issue: 1 }])
  })
  it('same boot: nothing is stopped; the running list follows the sessions', () => {
    const saved = nextRestore(null, BOOT, [s({ sessionId: 'a' })], 'm', NOW)
    const next = nextRestore(saved, BOOT + 30_000, [], 'm', NOW + 60_000)
    expect(next.stopped).toEqual([])
    expect(next.running).toEqual([])
  })
  it('new boot: what ran before is stopped until it runs again', () => {
    const saved = nextRestore(null, BOOT, [s({ sessionId: 'a', bgId: 'a1' }), s({ sessionId: 'b', bgId: 'b1' })], 'm', NOW)
    const after = nextRestore(saved, BOOT + 86_400_000, [s({ sessionId: 'a', bgId: 'a1', pid: null, state: 'needs-input' })], 'm', NOW + 86_400_000)
    expect(after.stopped.map((e) => e.sessionId)).toEqual(['a', 'b'])
    // Kept across app restarts on the same boot, minus what was resumed.
    const later = nextRestore(after, BOOT + 86_400_000 + 5_000, [s({ sessionId: 'a', bgId: 'a1' })], 'm', NOW + 86_500_000)
    expect(later.stopped.map((e) => e.sessionId)).toEqual(['b'])
    expect(later.running.map((e) => e.sessionId)).toEqual(['a'])
  })
  it('a second restart before resuming keeps the first list without duplicates', () => {
    const saved = { bootAt: BOOT, savedAt: 0, running: [{ sessionId: 'a', bgId: null, name: 'a', cwd: '', issue: null }], stopped: [{ sessionId: 'a', bgId: null, name: 'a', cwd: '', issue: null }] }
    expect(nextRestore(saved, BOOT + 9e6, [], 'm', NOW).stopped).toHaveLength(1)
  })
  it('boot times a little apart are the same boot', () => {
    expect(sameBoot(BOOT, BOOT + 90_000)).toBe(true)
    expect(sameBoot(BOOT, BOOT + 600_000)).toBe(false)
  })
  it('reads a saved file defensively', () => {
    expect(parseRestoreFile(null)).toBeNull()
    expect(parseRestoreFile({ running: [] })).toBeNull()
    expect(parseRestoreFile({ bootAt: 1, running: [{ sessionId: 'x' }, { nope: 1 }], stopped: 'bad' })).toEqual({
      bootAt: 1, savedAt: 0, running: [{ sessionId: 'x', bgId: null, name: 'x', cwd: '', issue: null }], stopped: [],
    })
  })
})
