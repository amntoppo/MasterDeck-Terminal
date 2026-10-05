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
  it('addAssign passes --model only when one is chosen', async () => {
    const f = fake({ stdout: 'added 5' })
    const cli = new MasterCli(f.run, '/lib', 'python3')
    await cli.addAssign({ issue: 1, name: '1-x', cwd: '/w', prompt: 'p', source: 's', model: 'opus[1m]' })
    await cli.addAssign({ issue: 1, name: '1-x', cwd: '/w', prompt: 'p', source: 's' })
    expect(f.calls[0].args.slice(-2)).toEqual(['--model', 'opus[1m]'])
    expect(f.calls[1].args).not.toContain('--model')
  })
  it('a forced board or snapshot tells ghcache to skip cached answers', async () => {
    const f = fake({ stdout: '{}' })
    const cli = new MasterCli(f.run, '/lib', 'python3')
    await cli.board('@current', true)
    await cli.snapshot(true)
    await cli.board()
    expect(f.calls.map((c) => c.opts?.env?.GHC_FORCE)).toEqual(['1', '1', undefined])
  })
  it('repoIssues runs master repo-issues for the named repositories, forced or not', async () => {
    const f = fake({ stdout: JSON.stringify({ cards: [], repos: [] }) })
    const cli = new MasterCli(f.run, '/lib', 'python3')
    expect(await cli.repoIssues(['acme/api', 'acme/web'])).toEqual({ ok: true, data: { cards: [], repos: [] } })
    await cli.repoIssues(['acme/api'], true)
    expect(f.calls[0].args).toEqual(['-m', 'master.cli', 'repo-issues', '--repos', 'acme/api,acme/web'])
    expect(f.calls.map((c) => c.opts?.env?.GHC_FORCE)).toEqual([undefined, '1'])
    expect(await new MasterCli(fake({ stdout: 'nope' }).run, '/lib', 'python3').repoIssues(['acme/api'])).toEqual({ ok: false, message: 'repo-issues printed invalid JSON' })
    expect(await new MasterCli(fake({ code: 2, stdout: '--repos takes owner/name, comma separated' }).run, '/lib', 'python3').repoIssues(['x'])).toEqual({ ok: false, message: '--repos takes owner/name, comma separated' })
  })
  it('repoIssues gives the CLI two minutes for each started ten repositories (it reads ten at a time)', async () => {
    const f = fake({ stdout: JSON.stringify({ cards: [], repos: [] }) })
    const cli = new MasterCli(f.run, '/lib', 'python3')
    for (const n of [1, 10, 11, 25, 30]) await cli.repoIssues(Array.from({ length: n }, (_, i) => `acme/r${i}`))
    expect(f.calls.map((c) => c.opts?.timeoutMs)).toEqual([120_000, 120_000, 240_000, 360_000, 360_000])
    expect(f.calls[3].args[4].split(',')).toHaveLength(25) // one call, whatever the number
  })
  it('board runs master board and parses its JSON', async () => {
    const f = fake({ stdout: JSON.stringify({ cards: [], columns: [] }) })
    const r = await new MasterCli(f.run, '/lib', 'python3').board()
    expect(f.calls[0].args).toEqual(['-m', 'master.cli', 'board', '--sprint', '@current'])
    expect(r).toEqual({ ok: true, data: { cards: [], columns: [] } })
    expect((await new MasterCli(fake({ stdout: 'nope' }).run, '/lib', 'python3').board()).ok).toBe(false)
  })
  it('draftAssign passes a chosen folder and returns where the session starts', async () => {
    const f = fake({ stdout: JSON.stringify({ issue: 9, repo: 'globex/app', name: 'n', cwd: '/code/globex/app', prompt: 'p', summary: 's', title: 't', url: 'u', workspace: '/code/globex', found: true, checkoutOf: 'globex/app' }) })
    const cli = new MasterCli(f.run, '/lib', 'python3')
    const r = await cli.draftAssign({ repo: 'globex/app', number: 9 }, 't', 'u')
    expect(f.calls[0].args).toEqual(['-m', 'master.cli', 'draft-assign', '9', '--repo', 'globex/app', '--title', 't', '--url', 'u'])
    expect(r.ok && [r.draft.cwd, r.draft.workspace, r.draft.found, r.draft.checkoutOf]).toEqual(['/code/globex/app', '/code/globex', true, 'globex/app'])
    await cli.draftAssign({ repo: 'globex/app', number: 9 }, 't', 'u', '/code/elsewhere')
    expect(f.calls[1].args.slice(-2)).toEqual(['--cwd', '/code/elsewhere'])
  })
  it('draftAssign carries the generic prompt and a search that was cut short', async () => {
    const f = fake({ stdout: JSON.stringify({ issue: 9, name: 'n', cwd: '/code', prompt: 'p', genericPrompt: 'g', summary: 's', title: 't', url: 'u', workspace: '/code', found: false, checkoutOf: 'acme/api', partial: true, searched: 2000 }) })
    const r = await new MasterCli(f.run, '/lib', 'python3').draftAssign({ repo: null, number: 9 })
    expect(r.ok && [r.draft.genericPrompt, r.draft.partial, r.draft.searched]).toEqual(['g', true, 2000])
  })
  it('checkout asks where a repository\'s sessions start', async () => {
    const f = fake({ stdout: JSON.stringify({ cwd: '/code/globex/app', workspace: '/code/globex', repo: 'globex/app', found: true }) })
    const cli = new MasterCli(f.run, '/lib', 'python3')
    expect(await cli.checkout('globex/app')).toEqual({ ok: true, cwd: '/code/globex/app', workspace: '/code/globex', found: true })
    expect(f.calls[0].args).toEqual(['-m', 'master.cli', 'checkout', 'globex/app'])
    expect((await cli.checkout('--oops')).ok).toBe(false)
    expect(f.calls).toHaveLength(1)
    expect((await new MasterCli(fake({ stdout: 'nope' }).run, '/lib', 'python3').checkout('globex/app')).ok).toBe(false)
    expect((await new MasterCli(fake({ stdout: '{}' }).run, '/lib', 'python3').checkout('globex/app')).ok).toBe(false)
  })
  it('draftAssign parses JSON and marks it as not from a proposal', async () => {
    const f = fake({ stdout: JSON.stringify({ issue: 9, name: 'n', cwd: '/w', prompt: 'p', summary: 's', title: 't', url: 'u' }) })
    const r = await new MasterCli(f.run, '/lib', 'python3').draftAssign({ repo: null, number: 9 })
    expect(r.ok && r.draft.proposalId).toBeNull()
    expect(r.ok && r.draft.name).toBe('n')
  })
})
