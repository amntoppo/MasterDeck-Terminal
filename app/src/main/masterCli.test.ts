import { describe, expect, it } from 'vitest'
import { cleanEnv } from './env'
import { MasterCli } from './masterCli'
import type { RunOpts, Runner } from './run'

function fake(reply: { code?: number; stdout?: string; stderr?: string }) {
  const calls: { cmd: string; args: string[]; opts?: RunOpts }[] = []
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return { run, calls }
}

describe('cleanEnv', () => {
  it('strips the Claude session markers so the CLI guard allows writes', () => {
    const e = cleanEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', HOME: '/h' }, '/bin')
    expect(e).toEqual({ HOME: '/h', PATH: '/bin' })
  })
  it('strips every session marker (child session, messaging token) but keeps user settings', () => {
    const e = cleanEnv({
      CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_EXECPATH: 'x', CLAUDE_CODE_VERSION: '2', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/c', HOME: '/h',
    })
    expect(e).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/c', HOME: '/h' })
  })
})

describe('MasterCli', () => {
  it('runs python -m master.cli with PYTHONPATH', async () => {
    const f = fake({ stdout: 'approved: 3' })
    const r = await new MasterCli(f.run, '/lib', 'python3').approve([3])
    expect(r).toEqual({ ok: true, message: 'approved: 3' })
    expect(f.calls[0].cmd).toBe('python3')
    expect(f.calls[0].args).toEqual(['-m', 'master.cli', 'approve', '3'])
    expect(f.calls[0].opts?.env?.PYTHONPATH).toBe('/lib')
  })
  it('reports the stdout error text on failure', async () => {
    const f = fake({ code: 1, stdout: 'proposal 3 is sent, not proposed' })
    expect(await new MasterCli(f.run, '/lib', 'python3').reject([3])).toEqual({ ok: false, message: 'proposal 3 is sent, not proposed' })
  })
  it('addAssign sends the prompt on stdin and parses the new id', async () => {
    const f = fake({ stdout: 'added 21\n' })
    const r = await new MasterCli(f.run, '/lib', 'python3').addAssign({ issue: 9, name: '9-x', cwd: '/w', prompt: 'P', source: 'app:issue:9:1' })
    expect(r).toEqual({ ok: true, id: 21 })
    const args = f.calls[0].args
    expect(args.slice(args.indexOf('--prompt'))).toEqual(['--prompt', '-'])
    expect(f.calls[0].opts?.stdin).toBe('P')
  })
  it('addAssign treats duplicate as a failure', async () => {
    const f = fake({ stdout: 'duplicate\n' })
    const r = await new MasterCli(f.run, '/lib', 'python3').addAssign({ issue: 9, name: '9-x', cwd: '/w', prompt: 'P', source: 's' })
    expect(r).toEqual({ ok: false, message: 'duplicate' })
  })
  it('spawn runs master spawn <id>', async () => {
    const f = fake({ stdout: '21: sent — started' })
    expect(await new MasterCli(f.run, '/lib', 'python3').spawn(21)).toEqual({ ok: true, message: '21: sent — started' })
    expect(f.calls[0].args).toEqual(['-m', 'master.cli', 'spawn', '21'])
  })
  it('a forced board or snapshot tells ghcache to skip cached answers', async () => {
    const f = fake({ stdout: '{}' })
    const cli = new MasterCli(f.run, '/lib', 'python3')
    await cli.board('@current', true)
    await cli.snapshot(true)
    await cli.board()
    expect(f.calls.map((c) => c.opts?.env?.GHC_FORCE)).toEqual(['1', '1', undefined])
  })
  it('board runs master board and parses its JSON', async () => {
    const f = fake({ stdout: JSON.stringify({ cards: [], columns: [] }) })
    const r = await new MasterCli(f.run, '/lib', 'python3').board()
    expect(f.calls[0].args).toEqual(['-m', 'master.cli', 'board', '--sprint', '@current'])
    expect(r).toEqual({ ok: true, data: { cards: [], columns: [] } })
    expect((await new MasterCli(fake({ stdout: 'nope' }).run, '/lib', 'python3').board()).ok).toBe(false)
  })
  it('draftAssign parses JSON and marks it as not from a proposal', async () => {
    const f = fake({ stdout: JSON.stringify({ issue: 9, name: 'n', cwd: '/w', prompt: 'p', summary: 's', title: 't', url: 'u' }) })
    const r = await new MasterCli(f.run, '/lib', 'python3').draftAssign(9)
    expect(r.ok && r.draft.proposalId).toBeNull()
    expect(r.ok && r.draft.name).toBe('n')
  })
})
