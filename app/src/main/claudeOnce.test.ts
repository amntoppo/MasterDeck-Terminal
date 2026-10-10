import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeOnce, tidyScratch } from './claudeOnce'
import { makeRunner } from './run'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-once-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Stand-in claudes are bash scripts: POSIX only (as the repo's other bash tests).
describe.skipIf(process.platform === 'win32')('claudeOnce', () => {
  it('runs a stand-in claude from an empty temp folder with the prompt on stdin, then removes the folder and its empty project folder', async () => {
    const projects = join(root, 'projects')
    mkdirSync(join(projects, '-kept'), { recursive: true })
    writeFileSync(join(projects, '-kept', 'x.jsonl'), '{}')
    const log = join(root, 'log.txt')
    // What Claude Code does: a project folder named after the cwd, even with no session saved.
    const bin = join(root, 'claude')
    writeFileSync(
      bin,
      `#!/bin/bash\nprintf '%s\\n' "$*" > "${log}"\npwd >> "${log}"\nls -A | wc -l | tr -d ' ' >> "${log}"\ncat >> "${log}"\nmkdir -p "${projects}/-tmp-$(basename "$PWD")/memory"\necho '{"title":"ok"}'\n`,
    )
    chmodSync(bin, 0o755)
    const r = await claudeOnce({ run: makeRunner(() => process.env), claude: bin, model: 'sonnet', prompt: 'the prompt', timeoutMs: 20_000, projectsDir: projects, prefix: 'masterdeck-meeting-' })
    expect(r).toMatchObject({ code: 0, stdout: '{"title":"ok"}\n' })
    const [args, cwd, files, stdin] = readFileSync(log, 'utf8').split('\n')
    expect(args).toBe('-p --model sonnet --no-session-persistence')
    expect(cwd).toMatch(/masterdeck-meeting-/)
    expect(files).toBe('0')
    expect(stdin).toBe('the prompt')
    expect(existsSync(cwd!)).toBe(false)
    expect(readdirSync(projects)).toEqual(['-kept'])
  }, 20_000)

  it('an abort kills claude at once (code -4) and still removes its folder', async () => {
    const bin = join(root, 'claude')
    writeFileSync(bin, `#!/bin/bash\nexec sleep 30\n`)
    chmodSync(bin, 0o755)
    const ac = new AbortController()
    const real = makeRunner(() => process.env)
    let cwd: string | undefined
    let abortedAt = 0
    // Abort shortly after the spawn, without waiting on anything the script writes.
    const run: typeof real = (cmd, args, opts) => {
      cwd = opts?.cwd
      setTimeout(() => {
        abortedAt = Date.now()
        ac.abort()
      }, 50)
      return real(cmd, args, opts)
    }
    const r = await claudeOnce({ run, claude: bin, model: 'sonnet', prompt: 'x', timeoutMs: 20_000, projectsDir: null, prefix: 'md-once-abort-', signal: ac.signal })
    expect(r).toMatchObject({ code: -4 })
    expect(abortedAt).toBeGreaterThan(0)
    expect(Date.now() - abortedAt).toBeLessThan(5_000)
    expect(cwd).toMatch(/md-once-abort-/)
    expect(existsSync(cwd!)).toBe(false)
  }, 20_000)
})

describe('tidyScratch', () => {
  it('removes old folders of the prefix and their empty project folders; a new one and others stay', () => {
    const tmp = join(root, 'tmp')
    const projects = join(root, 'projects')
    for (const d of ['masterdeck-meeting-old', 'masterdeck-meeting-new', 'other-old']) mkdirSync(join(tmp, d), { recursive: true })
    mkdirSync(join(projects, '-tmp-masterdeck-meeting-old'), { recursive: true })
    const old = (Date.now() - 3_600_000) / 1000
    for (const d of ['masterdeck-meeting-old', 'other-old']) utimesSync(join(tmp, d), old, old)
    tidyScratch('masterdeck-meeting-', projects, 600_000, Date.now(), tmp)
    expect(readdirSync(tmp).sort()).toEqual(['masterdeck-meeting-new', 'other-old'])
    expect(readdirSync(projects)).toEqual([])
  })
})
