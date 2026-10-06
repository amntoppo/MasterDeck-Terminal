import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PtyManager, startDir } from './ptys'

describe('startDir', () => {
  it('expands ~, keeps a real folder, and falls back to home', () => {
    const d = mkdtempSync(join(tmpdir(), 'ws-'))
    expect(startDir(d)).toBe(d)
    expect(startDir('~')).toBe(homedir())
    expect(startDir(join(d, 'missing'))).toBe(homedir())
    expect(startDir(undefined)).toBe(homedir())
    expect(startDir('~nobody')).toBe(homedir()) // not "~/": left alone, and it doesn't exist
  })
})

describe('PtyManager', () => {
  it('never opens claude for a trust prompt anywhere but the folder asked for', () => {
    const sent: string[] = []
    const tmp = mkdtempSync(join(tmpdir(), 'ws-'))
    // A binary that is not there: whatever this test gets wrong, it never runs the real claude.
    const m = new PtyManager(() => ({}), (ch) => sent.push(ch), () => join(tmp, 'no-such-claude'))
    // startDir would fall back to home: Claude Code would then ask to trust the home folder.
    const gone = join(tmp, 'missing')
    expect(m.open('p1', { kind: 'claude-here', cwd: gone }, 80, 24)).toMatchObject({ ok: false, exited: true, message: `not a folder on this Mac: ${gone}` })
    expect(m.open('p2', { kind: 'claude-here', cwd: 'relative/x' }, 80, 24)).toMatchObject({ ok: false })
    expect(m.isAlive('p1')).toBe(false)
    expect(sent).toEqual([])
  })
})
