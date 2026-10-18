import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionProcs } from './sessionProcs'
import type { RunResult, Runner } from './run'

const wrap = (cmd: string) => `/bin/zsh -c source /s.sh 2>/dev/null || true && eval '${cmd}' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-procs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A fake `ps` / `lsof`: the table and open files the test sets. */
function fake() {
  const t = { ps: '', psCode: 0, files: '', filesCode: 1, socks: '', calls: [] as string[][] }
  const run: Runner = async (cmd, args): Promise<RunResult> => {
    t.calls.push([cmd, ...args])
    if (/(^|\/)ps$/.test(cmd)) return { code: t.psCode, stdout: t.ps, stderr: t.psCode ? 'ps: /secret/path' : '' }
    if (args.includes('-iTCP')) return { code: 0, stdout: t.socks, stderr: '' }
    return { code: t.filesCode, stdout: t.files, stderr: '' }
  }
  return { t, run }
}

describe('SessionProcs', () => {
  it('lists a background command with its folder, port and output, and its exit code once it ends', async () => {
    const out = join(dir, 'tasks', 'bsrv1.output')
    const transcript = join(dir, 't.jsonl')
    const launch =
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `Command running in background with ID: bsrv1. Output is being written to: ${out}` }] },
      }) + '\n'
    writeFileSync(transcript, launch)
    const { t, run } = fake()
    let now = 1_000_000
    const procs = new SessionProcs(run, 'darwin', () => now)
    t.ps = [`  10     1    10   01:00  0.0  100 claude`, `  20    10    20   00:30  0.0  100 ${wrap('uv run main.py')}`, `  21    20    20   00:29  1.0  2048 python main.py`].join('\n')
    t.files = ['p20', 'fcwd', 'tDIR', 'n/work/api', 'f1', 'tREG', `n${out}`].join('\n')
    t.socks = ['p21', 'f4', 'n127.0.0.1:8000'].join('\n')
    const s = { key: 'k1', pid: 10, transcript }
    const a = await procs.list(s)
    expect(a.ok && a.supported && a.procs).toEqual([
      {
        pid: 20,
        command: 'uv run main.py',
        kind: 'background',
        cwd: '/work/api',
        startedAt: now - 30_000,
        state: 'running',
        exitCode: null,
        endedAt: null,
        ports: [{ host: '127.0.0.1', port: 8000 }],
        cpu: 1,
        memKb: 2148,
        children: [{ pid: 21, command: 'python main.py' }],
        hasOutput: true,
      },
    ])
    expect(t.calls.find((c) => c.includes('-iTCP'))).toContain('20,21')

    // Output: only of a process the last list found.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'tasks'))
    writeFileSync(out, '\x1b[32mUvicorn running\x1b[0m on http://127.0.0.1:8000\n')
    expect(procs.output('k1', 20)).toEqual({ ok: true, text: 'Uvicorn running on http://127.0.0.1:8000' })
    expect(procs.output('k1', 21).ok).toBe(false)
    expect(procs.output('other', 20).ok).toBe(false)

    // It ends: listed as exited, its code read from the notification, then it drops off.
    now += 2000
    t.ps = `  10     1    10   01:02  0.0  100 claude`
    writeFileSync(
      transcript,
      launch +
      JSON.stringify({ type: 'user', message: { content: '<task-notification>\n<task-id>bsrv1</task-id>\n<summary>Background command "Serve" failed with exit code 1</summary>\n</task-notification>' } }) + '\n',
    )
    const b = await procs.list(s)
    expect(b.ok && b.supported && b.procs.map((p) => [p.pid, p.state, p.exitCode, p.endedAt])).toEqual([[20, 'exited', 1, now]])
    now += 61_000
    const c = await procs.list(s)
    expect(c.ok && c.supported && c.procs).toEqual([])
  })

  it('drops a foreground call at once when it ends, and keeps what a seen shell left running', async () => {
    const { t, run } = fake()
    let now = 0
    const procs = new SessionProcs(run, 'darwin', () => now)
    t.ps = [`  10     1    10   01:00  0.0  100 claude`, `  30    10    30   00:01  0.0  100 ${wrap('npm run dev &')}`, `  31    30    30   00:01  0.0  100 node dev.js`].join('\n')
    const first = await procs.list({ key: 'k', pid: 10, transcript: null })
    expect(first.ok && first.supported && first.procs.map((p) => [p.pid, p.kind])).toEqual([[30, 'foreground']])
    now += 3000
    t.ps = [`  10     1    10   01:03  0.0  100 claude`, `  31     1    30   00:04  0.0  100 node dev.js`].join('\n')
    const next = await procs.list({ key: 'k', pid: 10, transcript: null })
    expect(next.ok && next.supported && next.procs.map((p) => [p.pid, p.kind, p.state])).toEqual([[31, 'detached', 'running']])
  })

  it('listAll: every session’s running processes and the strays, in three spawns', async () => {
    const { t, run } = fake()
    const now = 5_000_000
    const procs = new SessionProcs(run, 'darwin', () => now, '/Users/dev')
    t.ps = [
      `  10     1    10   09:00  0.0  100 claude`,
      `  20    10    20   00:30  0.0  100 ${wrap('npm run dev')}`,
      `  21    20    20   00:29  1.0  2048 node dev.js`,
      `  50     1    50   08:00  0.0  100 claude`,
      `  70     1    70   02:00  0.0  500 python -m http.server`,
      `  80     1    80   03:00  0.0  500 redis-server`,
      `  90     1    90   01:00  0.0  500 vite`,
      `  95     1    95   00:40  0.0  500 /usr/local/bin/node /work/old/server.js`,
      `  96     1    96   00:50  0.0  500 rails s`,
    ].join('\n')
    t.socks = ['p21', 'cnode', 'f4', 'n*:3000', 'p70', 'cpython', 'f3', 'n*:8000', 'p80', 'credis', 'f6', 'n127.0.0.1:6379', 'p90', 'cvite', 'f5', 'n*:5173', 'p95', 'cnode', 'f7', 'n*:4000', 'p96', 'cruby', 'f8', 'n*:3001'].join('\n')
    t.files = ['p20', 'fcwd', 'tDIR', 'n/work/api', 'p21', 'fcwd', 'tDIR', 'n/work/api', 'p70', 'fcwd', 'tDIR', 'n/work/api/docs', 'p80', 'fcwd', 'tDIR', 'n/', 'p90', 'fcwd', 'tDIR', 'n/work/apix', 'p95', 'fcwd', 'tDIR', 'n/work/old', 'p96', 'fcwd', 'tDIR', 'n/Users/dev/proj'].join('\n')
    const a = await procs.listAll([
      { key: 'k1', pid: 10, cwd: '/work/api', worktrees: ['/work/api/.claude/worktrees/w'] },
      { key: 'k2', pid: 50, cwd: '/work/web', worktrees: [] },
      { key: 'k3', pid: null, cwd: '/work/old', worktrees: [] },
      // A session in the home folder, or in /, looks for no strays: most of the machine sits below it.
      { key: 'k4', pid: null, cwd: '/Users/dev', worktrees: [] },
      { key: 'k5', pid: null, cwd: '/', worktrees: ['/Users'] },
    ])
    expect(t.calls).toHaveLength(3)
    expect(t.calls.filter((c) => /(^|\/)lsof$/.test(c[0]) && c.includes('-p'))[0]).toContain('20,21,70,80,90,95,96')
    expect(a.at).toBe(now)
    expect(Object.keys(a.sessions)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5'])
    expect(a.error).toBeUndefined()
    expect(a.sessions.k1.map((p) => [p.pid, p.command, p.cwd, p.state, p.ports.map((x) => x.port)])).toEqual([[20, 'npm run dev', '/work/api', 'running', [3000]]])
    expect(a.sessions.k2).toEqual([])
    expect(a.sessions.k3).toEqual([])
    // 21 is below a session; 80 is elsewhere; 90's folder only shares a prefix with /work/api; 96 is
    // only below home. 95 sits in a done session's folder.
    expect(a.strays).toEqual([
      { pid: 70, command: 'python -m http.server', cwd: '/work/api/docs', ports: [{ host: '*', port: 8000 }], startedAt: now - 120_000, folderOf: '/work/api' },
      { pid: 95, command: '/usr/local/bin/node /work/old/server.js', cwd: '/work/old', ports: [{ host: '*', port: 4000 }], startedAt: now - 40_000, folderOf: '/work/old' },
    ])
  })

  it('listAll leaves list()’s ended processes alone', async () => {
    const { t, run } = fake()
    let now = 0
    const procs = new SessionProcs(run, 'darwin', () => now)
    t.ps = [`  10     1    10   01:00  0.0  100 claude`, `  30    10    30   00:01  0.0  100 ${wrap('npm run dev &')}`, `  31    30    30   00:01  0.0  100 node dev.js`].join('\n')
    await procs.list({ key: 'k', pid: 10, transcript: null })
    now += 1000
    t.ps = [`  10     1    10   01:01  0.0  100 claude`, `  31     1    30   00:02  0.0  100 node dev.js`].join('\n')
    // Still listening in the session's folder after launchd adopted it: the session's, not a stray.
    t.socks = ['p31', 'cnode', 'f4', 'n*:3000'].join('\n')
    t.files = ['p31', 'fcwd', 'tDIR', 'n/w'].join('\n')
    // The group 30 was seen by list(): listAll still finds what it left running, and never shows an exited row.
    const all = await procs.listAll([{ key: 'k', pid: 10, cwd: '/w', worktrees: [] }])
    expect(all.sessions.k.map((p) => [p.pid, p.kind, p.state, p.ports.map((x) => x.port)])).toEqual([[31, 'detached', 'running', [3000]]])
    expect(all.strays).toEqual([])
    // list()'s last answer is untouched: 30 is still its process (no output file), 31 is not yet.
    expect(procs.output('k', 30)).toEqual({ ok: false, message: 'Its output goes straight to Claude Code; there is nothing to read here.' })
    expect(procs.output('k', 31)).toEqual({ ok: false, message: 'That process is not running.' })
    // list() still has 30 as its last answer: it ended in between, a foreground call, so it just drops off.
    const next = await procs.list({ key: 'k', pid: 10, transcript: null })
    expect(next.ok && next.supported && next.procs.map((p) => [p.pid, p.kind, p.state])).toEqual([[31, 'detached', 'running']])
    expect(procs.output('k', 31).ok).toBe(false)
  })

  it('listAll says when ps or lsof failed, rather than "nothing running"', async () => {
    const { t, run } = fake()
    t.psCode = -2
    t.socks = ['p70', 'f3', 'n*:8000'].join('\n')
    const a = await new SessionProcs(run, 'darwin', () => 7).listAll([{ key: 'k', pid: 10, cwd: '/w', worktrees: [] }])
    expect(a).toEqual({ at: 7, sessions: {}, strays: [], error: 'ps timed out' })
    expect(t.calls).toHaveLength(2)
    t.psCode = 1
    expect((await new SessionProcs(run, 'darwin', () => 7).listAll([{ key: 'k', pid: 10, cwd: '/w', worktrees: [] }])).error).toBe('ps failed (exit 1)')

    t.psCode = 0
    t.ps = [`  10     1    10   01:00  0.0  100 claude`, `  70     1    70   01:00  0.0  100 python -m http.server`].join('\n')
    t.files = ''
    t.filesCode = 2
    const b = await new SessionProcs(run, 'darwin', () => 7).listAll([{ key: 'k', pid: 10, cwd: '/w', worktrees: [] }])
    expect(b).toEqual({ at: 7, sessions: { k: [] }, strays: [], error: 'lsof failed (exit 2)' })
  })

  it('listAll matches a folder by its real path (lsof reports /private/tmp for /tmp)', async () => {
    const { mkdirSync, realpathSync, symlinkSync } = await import('node:fs')
    mkdirSync(join(dir, 'repo'))
    symlinkSync(join(dir, 'repo'), join(dir, 'link'))
    const { t, run } = fake()
    t.ps = `  70     1    70   01:00  0.0  100 vite`
    t.socks = ['p70', 'f3', 'n*:5173'].join('\n')
    t.files = ['p70', 'fcwd', 'tDIR', `n${realpathSync(join(dir, 'repo'))}/web`].join('\n')
    const a = await new SessionProcs(run, 'darwin', () => 0, '/nowhere').listAll([{ key: 'k', pid: null, cwd: join(dir, 'link'), worktrees: [] }])
    expect(a.strays.map((s) => [s.pid, s.folderOf])).toEqual([[70, realpathSync(join(dir, 'repo'))]])
  })

  it('listAll on Windows, and with nothing to look at', async () => {
    const { t, run } = fake()
    expect(await new SessionProcs(run, 'win32', () => 7).listAll([{ key: 'k', pid: 1, cwd: '/w', worktrees: [] }])).toEqual({ at: 7, sessions: {}, strays: [] })
    expect(await new SessionProcs(run, 'darwin', () => 7).listAll([])).toEqual({ at: 7, sessions: {}, strays: [] })
    expect(t.calls).toEqual([])
  })

  it('says the session is not running, and that Windows is not covered', async () => {
    const { t, run } = fake()
    const a = await new SessionProcs(run, 'darwin').list({ key: 'k', pid: null, transcript: null })
    expect(a).toEqual({ ok: true, supported: true, running: false, procs: [] })
    expect(t.calls).toEqual([])
    expect(await new SessionProcs(run, 'win32').list({ key: 'k', pid: 1, transcript: null })).toEqual({ ok: true, supported: false })
  })
})
