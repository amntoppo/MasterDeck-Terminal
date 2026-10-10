import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeOnce } from './claudeOnce'
import { makeRunner } from './run'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-once-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('claudeOnce', () => {
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
})
