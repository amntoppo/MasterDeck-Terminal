import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
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
})
