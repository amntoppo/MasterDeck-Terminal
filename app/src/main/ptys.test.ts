import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// node-pty is replaced for this whole file, before anything loads it: no test here can start a
// process, whatever PtyManager does (a red test included).
const spawned = vi.hoisted(() => [] as { file: string; args: string[]; cwd: string }[])
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], o: { cwd: string }) => {
    spawned.push({ file, args, cwd: o.cwd })
    return { onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} }
  },
}))

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
  beforeEach(() => void (spawned.length = 0))
  function manager() {
    const sent: string[] = []
    const tmp = mkdtempSync(join(tmpdir(), 'ws-'))
    const m = new PtyManager(() => ({}), (ch) => sent.push(ch), () => join(tmp, 'no-such-claude'))
    return { m, spawned, sent, tmp }
  }
  it('never opens claude for a trust prompt anywhere but the folder asked for', () => {
    const { m, spawned, sent, tmp } = manager()
    // startDir would fall back to home: Claude Code would then ask to trust the home folder.
    const gone = join(tmp, 'missing')
    expect(m.open('p1', { kind: 'claude-here', cwd: gone }, 80, 24)).toMatchObject({ ok: false, exited: true, message: `not a folder on this Mac: ${gone}` })
    expect(m.open('p2', { kind: 'claude-here', cwd: 'relative/x' }, 80, 24)).toMatchObject({ ok: false })
    expect(m.isAlive('p1')).toBe(false)
    expect([spawned, sent]).toEqual([[], []])
    expect(m.open('p3', { kind: 'claude-here', cwd: tmp }, 80, 24)).toMatchObject({ ok: true })
    expect(spawned).toEqual([{ file: join(tmp, 'no-such-claude'), args: [], cwd: tmp }])
  })
  it("a browser is never handed the window's claude pane by asking for it as a shell", () => {
    const { m, spawned, tmp } = manager()
    const id = `claude:${tmp}`
    expect(m.open(id, { kind: 'claude-here', cwd: tmp }, 80, 24)).toMatchObject({ ok: true })
    expect(m.open(id, { kind: 'shell', cwd: tmp }, 80, 24, true)).toEqual({ ok: false, replay: '', seq: 0, exited: true, message: 'that terminal is open on the Mac only' })
    expect(m.open(id, { kind: 'attach', bgId: 'abcd1234' }, 80, 24, true)).toMatchObject({ ok: false })
    // The window itself remounts its own pane as before.
    expect(m.open(id, { kind: 'claude-here', cwd: tmp }, 80, 24)).toMatchObject({ ok: true, exited: false })
    expect(spawned.length).toBe(1)
  })
  it('a browser still shares a pane of the kind it asks for', () => {
    const { m, spawned, tmp } = manager()
    expect(m.open('sh:1', { kind: 'shell', cwd: tmp }, 80, 24)).toMatchObject({ ok: true })
    expect(m.open('sh:1', { kind: 'shell', cwd: tmp }, 80, 24, true)).toMatchObject({ ok: true, exited: false })
    expect(m.open('sh:1', { kind: 'builder', resume: false }, 80, 24, true)).toMatchObject({ ok: false })
    expect(spawned.length).toBe(1)
  })
})
