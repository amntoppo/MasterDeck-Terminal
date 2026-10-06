import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanEnv } from './env'
import { MasterCli } from './masterCli'
import { makeRunner } from './run'

const LIB = resolve(__dirname, '../../../skills/master/lib')

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'])
    return true
  } catch {
    return false
  }
}

// Runs the real master CLI against a throwaway MASTER_HOME, as if launched from a Claude session.
describe.runIf(hasPython())('MasterCli against the real CLI', () => {
  it('adds and approves an ASSIGN even when the parent env says CLAUDECODE=1', async () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-master-'))
    const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'not-master', MASTER_HOME: home }
    const cli = new MasterCli(makeRunner(() => cleanEnv(env)), LIB, 'python3')
    const prompt = 'You own #9.\n\nSet up only.'
    const added = await cli.addAssign({ issue: 9, name: '9-test', cwd: tmpdir(), prompt, source: 'app:issue:9:1' })
    expect(added).toEqual({ ok: true, id: 1 })
    const approved = await cli.approve([1])
    expect(approved.ok).toBe(true)
    const led = JSON.parse(readFileSync(join(home, 'ledger.json'), 'utf8'))
    expect(led.proposals[0]).toMatchObject({ id: 1, kind: 'ASSIGN', issue: 9, status: 'approved', message: prompt })
    expect(led.proposals[0].target.spawn).toMatchObject({ name: '9-test', prompt })
    const again = await cli.approve([1])
    expect(again.ok).toBe(false)
  })

  // HOME is a temp folder: the CLI reads `.claude.json` there, never the machine's own.
  it('says whether Claude Code may work in a folder, and notices when the user allows it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-home-'))
    const folder = join(home, 'code', 'api')
    mkdirSync(folder, { recursive: true })
    const { CLAUDE_CONFIG_DIR: _none, ...rest } = process.env
    const env = { ...rest, HOME: home, USERPROFILE: home, MASTER_HOME: join(home, 'master') }
    const cli = new MasterCli(makeRunner(() => cleanEnv(env)), LIB, 'python3')
    const file = join(home, '.claude.json')
    // Claude Code keys a folder by its real path (no links; `native` also spells out Windows short names, as the CLI does).
    const allow = (yes: boolean) => writeFileSync(file, JSON.stringify({ projects: { [realpathSync.native(folder)]: { hasTrustDialogAccepted: yes } } }), 'utf8')
    expect(await cli.trust(folder)).toBeNull() // no file: not known
    allow(false)
    expect(await cli.trust(folder)).toBe(false)
    const before = readFileSync(file, 'utf8')
    setTimeout(() => allow(true), 300)
    expect(await cli.trust(folder, 20)).toBe(true)
    expect(await cli.trust(join(home, 'code'))).toBe(false) // a parent of a trusted folder is not trusted by it
    allow(false)
    await cli.trust(folder)
    expect(readFileSync(file, 'utf8')).toBe(before) // read only
  }, 30_000)
})
