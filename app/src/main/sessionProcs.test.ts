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
  const t = { ps: '', files: '', socks: '', calls: [] as string[][] }
  const run: Runner = async (cmd, args): Promise<RunResult> => {
    t.calls.push([cmd, ...args])
    if (/(^|\/)ps$/.test(cmd)) return { code: 0, stdout: t.ps, stderr: '' }
    if (args.includes('-iTCP')) return { code: 0, stdout: t.socks, stderr: '' }
    return { code: 1, stdout: t.files, stderr: '' }
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

  it('says the session is not running, and that Windows is not covered', async () => {
    const { t, run } = fake()
    const a = await new SessionProcs(run, 'darwin').list({ key: 'k', pid: null, transcript: null })
    expect(a).toEqual({ ok: true, supported: true, running: false, procs: [] })
    expect(t.calls).toEqual([])
    expect(await new SessionProcs(run, 'win32').list({ key: 'k', pid: 1, transcript: null })).toEqual({ ok: true, supported: false })
  })
})
