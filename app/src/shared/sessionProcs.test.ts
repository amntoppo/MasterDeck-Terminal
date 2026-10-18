import { describe, expect, it } from 'vitest'
import {
  cleanOutput,
  commandName,
  descendants,
  findStrays,
  insideFolder,
  transcriptTasks,
  formatUptime,
  isClaudeShell,
  isPortUrl,
  parseEtime,
  parseLsof,
  parseListen,
  parsePs,
  portLabel,
  portUrl,
  sessionGroups,
  shellCommand,
  taskIdOf,
  uniquePorts,
} from './sessionProcs'

const wrap = (cmd: string) =>
  `/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && eval '${cmd.replace(/'/g, "'\\''")}' < /dev/null && pwd -P >| /tmp/claude-8b21-cwd`

// pid ppid pgid etime %cpu rss command
const PS = [
  `  100     1   100    1-02:03:04   1.5  90000 claude bg-spare --bg-spare /tmp/cc-daemon-501/x/spare/a.claim.sock`,
  `  200   100   200       03:04   0.0   1232 ${wrap('uv run main.py')}`,
  `  201   200   200       03:03   2.5  80000 /usr/bin/python3 main.py`,
  `  202   201   200       03:02   0.5  10000 /usr/bin/python3 -c worker`,
  `  300   100   300       00:02   0.0   1000 ${wrap("echo 'hi' && npm run dev")}`,
  `  400   100   400       10:00   0.0   1728 caffeinate -i -t 300`,
  `  500     1   500       05:00   0.0   2000 ${wrap('nohup node server.js &')}`,
  `  501     1   555       04:59   3.0  50000 node server.js`,
  `  600     1   600       04:59   3.0  50000 node someone-else.js`,
].join('\n')

describe('parsePs', () => {
  it('reads the columns and the elapsed time', () => {
    const rows = parsePs(PS)
    expect(rows).toHaveLength(9)
    expect(rows[0]).toMatchObject({ pid: 100, ppid: 1, pgid: 100, elapsed: 93784, cpu: 1.5, rssKb: 90000 })
    expect(rows[1].command).toContain("eval 'uv run main.py'")
  })
  it('parses etime forms', () => {
    expect(parseEtime('00:05')).toBe(5)
    expect(parseEtime('01:02:03')).toBe(3723)
    expect(parseEtime('2-00:00:01')).toBe(172801)
    expect(parseEtime('junk')).toBe(0)
  })
})

describe('Claude shells', () => {
  it('recognises the wrapper and unquotes the command', () => {
    expect(isClaudeShell(wrap('ls'))).toBe(true)
    expect(isClaudeShell('/bin/zsh -c ls')).toBe(false)
    expect(shellCommand(wrap("echo 'hi' && npm run dev"))).toBe("echo 'hi' && npm run dev")
    expect(shellCommand('node server.js')).toBe('node server.js')
  })
})

describe('sessionGroups', () => {
  const rows = parsePs(PS)
  it('groups each shell under the session with its tree, skipping Claude Code’s own helpers', () => {
    const g = sessionGroups(rows, 100, new Set(), 1_000_000)
    expect(g.map((x) => x.pid)).toEqual([200, 300])
    expect(g[0]).toMatchObject({ command: 'uv run main.py', shell: true, pids: [200, 201, 202], cpu: 3, memKb: 91232, startedAt: 1_000_000 - 184_000 })
    expect(g[0].children.map((c) => c.pid)).toEqual([201, 202])
  })
  it('finds what a seen shell left running in its process group', () => {
    const rows2 = parsePs(PS.replace(/  501     1   555/, '  501     1   500'))
    const g = sessionGroups(rows2, 100, new Set([500]), 0)
    // 500 (the shell, adopted by launchd) leads the group; 501 runs below it in the table only by pgid.
    expect(g.find((x) => x.pid === 500)).toMatchObject({ shell: false, pids: [500] })
    expect(g.find((x) => x.pid === 501)).toMatchObject({ shell: false, command: 'node server.js' })
    expect(g.some((x) => x.pid === 600)).toBe(false)
  })
  it('descendants walks the whole tree once', () => {
    expect(descendants(rows, 100).map((r) => r.pid)).toEqual([200, 201, 202, 300, 400])
  })
})

describe('lsof', () => {
  it('reads folders, stdout files and sockets', () => {
    const files = ['p200', 'fcwd', 'tDIR', 'n/work/api', 'f1', 'tREG', 'n/tmp/claude-501/p/s/tasks/b1x2.output', 'p201', 'fcwd', 'tDIR', 'n/work/api', 'f1', 'tPIPE', 'n->0x1'].join('\n')
    const socks = ['p201', 'f4', 'n127.0.0.1:8000', 'f5', 'n[::1]:8000', 'f6', 'n*:5173'].join('\n')
    const a = parseLsof(files)
    expect(a.get(200)).toEqual({ cwd: '/work/api', out: '/tmp/claude-501/p/s/tasks/b1x2.output', listens: [] })
    expect(a.get(201)).toEqual({ cwd: '/work/api', listens: [] })
    const b = parseLsof(socks).get(201)!
    expect(uniquePorts(b.listens).map(portLabel)).toEqual(['localhost:5173', 'localhost:8000'])
    expect(taskIdOf(a.get(200)!.out)).toBe('b1x2')
    expect(taskIdOf('/var/log/app.log')).toBeNull()
  })
  it('turns sockets into addresses to open', () => {
    expect(portUrl(parseListen('0.0.0.0:3000')!)).toBe('http://localhost:3000')
    expect(portUrl(parseListen('192.168.1.5:3000')!)).toBe('http://192.168.1.5:3000')
    expect(parseListen('->0x123')).toBeNull()
    expect(parseListen('*:0')).toBeNull()
  })
  it('opens only http to localhost or an IP with a port', () => {
    expect(isPortUrl('http://localhost:8000')).toBe(true)
    expect(isPortUrl('http://10.0.0.2:80')).toBe(true)
    expect(isPortUrl('http://[::1]:80')).toBe(true)
    for (const bad of ['https://localhost:8000', 'http://evil.com:80', 'file:///etc/passwd', 'http://localhost', 'http://localhost:99999', 'http://localhost:80/x', 42])
      expect(isPortUrl(bad)).toBe(false)
  })
})

describe('transcriptTasks', () => {
  const note = (id: string, summary: string) =>
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>` },
    })
  const launched = (text: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } })
  it('finds commands sent to the background and their exit codes by task id', () => {
    const t = transcriptTasks([
      launched('Command running in background with ID: b9. Output is being written to: /tmp/x/tasks/b9.output'),
      note('b1', 'Background command "Serve" completed (exit code 0)'),
      note('b2', 'Background command "Test" failed with exit code 2'),
      note('a1', 'Agent "x" finished'),
      // Someone quoting the words in a message is not Claude Code saying them.
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'running in background with ID: fake1' }] } }),
      'not json',
    ])
    expect([...t.background].sort()).toEqual(['a1', 'b1', 'b2', 'b9'])
    expect([...t.exit]).toEqual([
      ['b1', 0],
      ['b2', 2],
    ])
  })
})

describe('findStrays', () => {
  // pid ppid pgid etime %cpu rss command
  const rows = parsePs(
    [
      `  100     1   100   10:00  0.0  1000 claude`,
      `  110   100   110   05:00  0.0  1000 node session-child.js`,
      `  200     1   200   02:00  0.0  1000 node left-behind.js`,
      `  201   200   200   01:59  0.0  1000 node worker.js`,
      `  300     1   300   03:00  0.0  1000 python -m http.server`,
      `  400     1   400   04:00  0.0  1000 redis-server`,
      `  500     1   500   01:00  0.0  1000 vite`,
    ].join('\n'),
  )
  const info = new Map([
    [100, { cwd: '/work/api', listens: [{ host: '127.0.0.1', port: 9999 }] }],
    [110, { cwd: '/work/api', listens: [{ host: '127.0.0.1', port: 3000 }] }],
    [200, { cwd: '/work/api/web', listens: [{ host: '*', port: 8080 }] }],
    [201, { cwd: '/work/api/web', listens: [{ host: '*', port: 8081 }, { host: '[::1]', port: 8080 }] }],
    [300, { cwd: '/work/api-old', listens: [{ host: '*', port: 8000 }] }],
    [400, { cwd: '/', listens: [{ host: '127.0.0.1', port: 6379 }] }],
    [500, { cwd: '/work/api/.claude/worktrees/x', listens: [{ host: '*', port: 5173 }] }],
  ])
  const folders = ['/work/api/', '/work/api/.claude/worktrees/x']

  it('finds listeners in a session folder or worktree, not below a session, on whole path segments', () => {
    const s = findStrays(rows, info, folders, [100], 1_000_000)
    expect(s).toEqual([
      // Its worker's ports fold into it.
      { pid: 200, command: 'node left-behind.js', cwd: '/work/api/web', ports: [{ host: '*', port: 8080 }, { host: '*', port: 8081 }], startedAt: 1_000_000 - 120_000, folderOf: '/work/api/' },
      { pid: 500, command: 'vite', cwd: '/work/api/.claude/worktrees/x', ports: [{ host: '*', port: 5173 }], startedAt: 1_000_000 - 60_000, folderOf: '/work/api/.claude/worktrees/x' },
    ])
  })
  it('counts a listener below a session once that session is gone', () => {
    const s = findStrays(rows, info, folders, [], 0)
    expect(s.map((x) => [x.pid, x.ports.map((p) => p.port)])).toEqual([
      [100, [3000, 9999]],
      [200, [8080, 8081]],
      [500, [5173]],
    ])
  })
  it('matches folders on whole segments', () => {
    expect(insideFolder('/a/b', '/a/b')).toBe(true)
    expect(insideFolder('/a/b/c', '/a/b')).toBe(true)
    expect(insideFolder('/a/b/c', '/a/b/')).toBe(true)
    expect(insideFolder('/a/bc', '/a/b')).toBe(false)
    expect(insideFolder('/a', '/a/b')).toBe(false)
    expect(insideFolder('/a', '')).toBe(false)
  })
  it('leaves out a listener a session already claims (a detached leftover in its group)', () => {
    expect(findStrays(rows, info, folders, [100], 0, new Set([500])).map((s) => s.pid)).toEqual([200])
  })
  it('gives a command line’s executable name', () => {
    expect(commandName('/usr/bin/python3 -m http.server 8000')).toBe('python3')
    expect(commandName('vite')).toBe('vite')
    expect(commandName('')).toBe('')
  })
  it('finds nothing without folders', () => {
    expect(findStrays(rows, info, [], [100], 0)).toEqual([])
  })
})

describe('formatting', () => {
  it('cleans terminal output', () => {
    expect(cleanOutput('\x1b[32mready\x1b[0m on :8000\nprogress 10%\rprogress 100%\n')).toBe('ready on :8000\nprogress 100%\n')
  })
  it('formats uptime', () => {
    expect(formatUptime(12_000)).toBe('12s')
    expect(formatUptime(4 * 60_000)).toBe('4m')
    expect(formatUptime(125 * 60_000)).toBe('2h 5m')
    expect(formatUptime(76 * 3600_000)).toBe('3d 4h')
  })
})
