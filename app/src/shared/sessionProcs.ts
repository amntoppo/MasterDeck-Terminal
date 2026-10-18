/**
 * A session's running processes (issue #115): the shells Claude Code started for its Bash tool
 * (background ones, and the foreground one running now), everything below them, and what they left
 * running on their own. Read from `ps` and `lsof` by main (main/sessionProcs.ts); this file is the
 * parsing and grouping, with no node imports.
 *
 * A shell Claude Code starts looks like `zsh -c source <snapshot> … && eval '<command>' < /dev/null
 * && pwd -P >| /tmp/claude-<hex>-cwd`, a child of the session's `claude` process, and the leader of
 * its own process group. A background shell writes to `<tmp>/claude-<uid>/<project>/<sessionId>/tasks/<taskId>.output`
 * (its stdout); so does a foreground one in recent versions, and only the transcript tells them apart
 * ("running in background with ID: …"). `cmd &` or `nohup cmd &` outlives its shell: it is
 * re-parented to launchd but keeps the shell's process group, which is how it is still found.
 */

/** One line of `ps ax -o pid=,ppid=,pgid=,etime=,%cpu=,rss=,command=`. */
export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
  /** Seconds since it started. */
  elapsed: number
  cpu: number
  /** Resident memory, KB. */
  rssKb: number
  command: string
}

export const PS_ARGS = ['ax', '-o', 'pid=,ppid=,pgid=,etime=,%cpu=,rss=,command=']

/** A listening TCP socket, as lsof names it (`127.0.0.1:8000`, `*:3000`, `[::1]:5173`). */
export interface Listen {
  host: string
  port: number
}

export interface ProcChild {
  pid: number
  command: string
}

export type ProcKind = 'background' | 'foreground' | 'detached'

export interface SessionProc {
  /** The shell's pid (the process group's leader); for a detached group, its lowest pid. */
  pid: number
  /** The command Claude ran (unwrapped from the shell line), or the detached process's own. */
  command: string
  kind: ProcKind
  cwd: string | null
  startedAt: number
  state: 'running' | 'exited'
  /** A background command's, from its notification in the transcript; null: not known (yet). */
  exitCode: number | null
  endedAt: number | null
  /** Ports, one per number (an IPv4 and IPv6 socket on the same port count once), sorted. */
  ports: Listen[]
  /** Summed over the shell and everything below it. */
  cpu: number
  memKb: number
  /** The processes below the shell (and the detached group's others). */
  children: ProcChild[]
  /** Whether its recent output can be read (a background command's file, a detached process's log). */
  hasOutput: boolean
}

export type ProcsAnswer =
  | { ok: true; supported: true; running: boolean; procs: SessionProc[] }
  | { ok: true; supported: false }
  | { ok: false; message: string }

/** An exited command stays in the list this long, with its exit code, then drops off. */
export const EXITED_KEEP_MS = 60_000

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim())
  if (!m) return 0
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

export function parsePs(text: string): ProcRow[] {
  const out: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.,]+)\s+(\d+)\s(.*)$/.exec(line)
    if (!m) continue
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      elapsed: parseEtime(m[4]),
      cpu: Number(m[5].replace(',', '.')) || 0,
      rssKb: Number(m[6]),
      command: m[7].trim(),
    })
  }
  return out
}

const SHELL_TAIL = /&& pwd -P >\| \S*claude-[0-9a-f]+-cwd\s*$/

/** Is this the shell Claude Code runs a Bash tool call in? */
export function isClaudeShell(command: string): boolean {
  return SHELL_TAIL.test(command) && /\beval '/.test(command)
}

/** The command a Claude Code shell runs (`eval '<command>'`), unquoted; the line itself when it is not one. */
export function shellCommand(command: string): string {
  if (!isClaudeShell(command)) return command
  const m = /\beval '((?:[^']|'\\'')*)'(?: < \/dev\/null)? && pwd -P >\| /.exec(command)
  return m ? m[1].replace(/'\\''/g, "'") : command
}

/** Everything below `pid` in the tree (not `pid` itself), parents before children. */
export function descendants(rows: ProcRow[], pid: number): ProcRow[] {
  const kids = new Map<number, ProcRow[]>()
  for (const r of rows) {
    if (r.pid === r.ppid) continue
    const list = kids.get(r.ppid)
    if (list) list.push(r)
    else kids.set(r.ppid, [r])
  }
  const out: ProcRow[] = []
  const seen = new Set<number>([pid])
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      if (seen.has(k.pid)) continue
      seen.add(k.pid)
      out.push(k)
      walk(k.pid)
    }
  }
  walk(pid)
  return out
}

/** A group of processes before main adds lsof's answers: a shell and its tree, or a detached group. */
export interface ProcGroup {
  pid: number
  command: string
  shell: boolean
  startedAt: number
  cpu: number
  memKb: number
  /** Every pid in it, the leader first. */
  pids: number[]
  children: ProcChild[]
}

const sum = (rows: ProcRow[], f: (r: ProcRow) => number) => Math.round(rows.reduce((a, r) => a + f(r), 0) * 10) / 10

/**
 * The session's groups: each Claude Code shell under `root` (the session's `claude`) with its tree,
 * then the processes outside that tree still in a process group one of its shells led (`groups`:
 * the shell pids main has seen for this session).
 */
export function sessionGroups(rows: ProcRow[], root: number, groups: ReadonlySet<number>, now: number): ProcGroup[] {
  const out: ProcGroup[] = []
  const taken = new Set<number>([root])
  const group = (leader: ProcRow, rest: ProcRow[], shell: boolean): ProcGroup => {
    const all = [leader, ...rest]
    for (const r of all) taken.add(r.pid)
    return {
      pid: leader.pid,
      command: shell ? shellCommand(leader.command) : leader.command,
      shell,
      startedAt: now - leader.elapsed * 1000,
      cpu: sum(all, (r) => r.cpu),
      memKb: sum(all, (r) => r.rssKb),
      pids: all.map((r) => r.pid),
      children: rest.map((r) => ({ pid: r.pid, command: r.command })),
    }
  }
  for (const r of rows) if (r.ppid === root && isClaudeShell(r.command)) out.push(group(r, descendants(rows, r.pid), true))
  // What a shell left running when it ended: same process group, now outside the tree.
  const left = new Map<number, ProcRow[]>()
  for (const r of rows) {
    if (taken.has(r.pid) || !groups.has(r.pgid) || r.pgid === root) continue
    const list = left.get(r.pgid)
    if (list) list.push(r)
    else left.set(r.pgid, [r])
  }
  for (const list of left.values()) {
    const set = new Set(list.map((r) => r.pid))
    // Its top: the ones whose parent is not in the group (usually one, adopted by launchd).
    const tops = list.filter((r) => !set.has(r.ppid)).sort((a, b) => a.pid - b.pid)
    for (const top of tops) {
      if (taken.has(top.pid)) continue
      out.push(group(top, descendants(list, top.pid), false))
    }
  }
  return out
}

/** One process's open files that matter here: its folder, its stdout, its listening sockets. */
export interface LsofInfo {
  cwd?: string
  /** stdout, when it is a regular file. */
  out?: string
  listens: Listen[]
}

/** lsof's `-F` output (`p`, `f`, `t`, `n` fields) → per pid. */
export function parseLsof(text: string): Map<number, LsofInfo> {
  const map = new Map<number, LsofInfo>()
  let cur: LsofInfo | null = null
  let fd = ''
  let type = ''
  for (const line of text.split('\n')) {
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') {
      const pid = Number(val)
      cur = map.get(pid) ?? { listens: [] }
      map.set(pid, cur)
      fd = ''
      type = ''
    } else if (!cur) continue
    else if (tag === 'f') {
      fd = val
      type = ''
    } else if (tag === 't') type = val
    else if (tag === 'n') {
      if (fd === 'cwd') cur.cwd = val
      else if (fd === '1' && type === 'REG') cur.out = val
      else if (/^\d+$/.test(fd) && fd !== '1') {
        const l = parseListen(val)
        if (l) cur.listens.push(l)
      }
    }
  }
  return map
}

/** `127.0.0.1:8000`, `*:3000`, `[::1]:5173` → host and port. */
export function parseListen(name: string): Listen | null {
  const m = /^(\*|\[[0-9a-fA-F:.%a-z]+\]|[0-9.]+|[A-Za-z0-9.-]+):(\d{1,5})(?:\s|$)/.exec(name.trim())
  if (!m) return null
  const port = Number(m[2])
  return port > 0 && port < 65536 ? { host: m[1], port } : null
}

const LOOPBACK = /^(\*|127\.\d+\.\d+\.\d+|\[::1?\]|0\.0\.0\.0|localhost)$/

/** The address to open in a browser: localhost for any loopback or wildcard socket. */
export function portUrl(l: Listen): string {
  return `http://${LOOPBACK.test(l.host) ? 'localhost' : l.host}:${l.port}`
}

/** `localhost:8000` style text for a port. */
export function portLabel(l: Listen): string {
  return portUrl(l).replace(/^http:\/\//, '')
}

/** The only addresses `openPort` opens: http to localhost or an IP literal, with a port. */
export function isPortUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 64) return false
  const m = /^http:\/\/(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(url)
  return !!m && Number(m[2]) > 0 && Number(m[2]) < 65536
}

/** One per port number, a loopback or wildcard socket preferred, sorted by port. */
export function uniquePorts(listens: Listen[]): Listen[] {
  const by = new Map<number, Listen>()
  for (const l of listens) {
    const had = by.get(l.port)
    if (!had || (!LOOPBACK.test(had.host) && LOOPBACK.test(l.host))) by.set(l.port, l)
  }
  return [...by.values()].sort((a, b) => a.port - b.port)
}

/** A background command's task id, from its output file's path. */
export function taskIdOf(path: string | undefined): string | null {
  return path ? (/[\\/]tasks[\\/]([A-Za-z0-9_-]+)\.output$/.exec(path)?.[1] ?? null) : null
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const TAG = (name: string, text: string): string | null => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? null

/** What a transcript says about its commands' task ids: which went to the background, and how they ended. */
export interface TranscriptTasks {
  background: Set<string>
  exit: Map<string, number>
}

export function transcriptTasks(lines: string[]): TranscriptTasks {
  const background = new Set<string>()
  const exit = new Map<string, number>()
  for (const line of lines) {
    if (!line.includes('<task-notification>') && !(line.includes('"tool_result"') && line.includes('background'))) continue
    let d: Obj
    try {
      d = obj(JSON.parse(line))
    } catch {
      continue
    }
    if (d.type !== 'user' || d.isSidechain === true) continue
    const m = obj(d.message)
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content.map(obj) : []
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => str(obj(c).text)).join('\n') : ''
        // "Command running in background with ID: b1x2", and the same for one the user sent there.
        for (const x of text.matchAll(/\bbackground(?:ed)?\b[^\n]{0,40}?\bID: ([A-Za-z0-9_-]+)/g)) background.add(x[1])
        continue
      }
      for (const n of str(b.text).split('</task-notification>')) {
        const id = TAG('task-id', n)
        if (!id || !n.includes('<task-notification>')) continue
        background.add(id)
        const code = /\bexit code (-?\d+)/.exec(TAG('summary', n) ?? '')?.[1]
        if (code !== undefined) exit.set(id, Number(code))
      }
    }
  }
  return { background, exit }
}

/** Recent output for the screen: colours and cursor moves dropped, carriage-return redraws kept to their last state. */
export function cleanOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '')
    .split('\n')
    .map((l) => {
      const parts = l.replace(/\r$/, '').split('\r')
      return parts[parts.length - 1]
    })
    .join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/** "12s", "4m", "2h 5m", "3d 4h" */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** "84 MB" / "1.2 GB" from KB. */
export function formatMem(kb: number): string {
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`
}

/**
 * A process listening on a TCP port in a session's folder or one of its worktrees, not below any
 * running session (the Dashboard, #183): a dev server a session left behind, or one started by hand.
 * ponytail: only processes with ports are found; one without a port needs a full table walk per read.
 */
export interface StrayProc {
  pid: number
  command: string
  cwd: string | null
  ports: Listen[]
  startedAt: number
  /** The session folder or worktree it sits in (the deepest that holds it). */
  folderOf: string | null
}

/** Every session's running processes, by Session.key, and the strays (`procs:all`). */
export interface ProcsAll {
  at: number
  sessions: Record<string, SessionProc[]>
  strays: StrayProc[]
  /** Why the read is incomplete ("ps failed (exit 1)"): the lists are then not "nothing running". */
  error?: string
}

/** A command line's executable, base name only (`/usr/bin/python3 -m http.server` → `python3`): what a web tab gets of a stray. */
export function commandName(command: string): string {
  const exe = command.trim().split(/\s+/)[0] ?? ''
  return exe.slice(exe.lastIndexOf('/') + 1)
}

/** Is `path` the folder or inside it, on whole path segments (`/a/b` holds `/a/b/c`, not `/a/bc`)? */
export function insideFolder(path: string, folder: string): boolean {
  const f = folder.length > 1 ? folder.replace(/\/+$/, '') : folder
  if (!f) return false
  return path === f || path.startsWith(f === '/' ? '/' : `${f}/`)
}

/**
 * The strays among the listening processes in `info` (lsof's answer, by pid): its cwd inside one of
 * `folders`, neither a session pid nor below one, and not `claimed` (in a session's process group,
 * listed under that session already). A listener below another stray is folded into the topmost
 * one (its ports added), so a server with workers shows once.
 */
export function findStrays(
  rows: ProcRow[],
  info: ReadonlyMap<number, LsofInfo>,
  folders: readonly string[],
  sessionPids: readonly number[],
  now: number,
  claimed: ReadonlySet<number> = new Set(),
): StrayProc[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const sessions = new Set(sessionPids)
  /** The pid's ancestors, nearest first (not the pid itself). */
  const ancestors = (pid: number): number[] => {
    const out: number[] = []
    const seen = new Set<number>([pid])
    let r = byPid.get(pid)
    while (r && r.ppid > 0 && !seen.has(r.ppid)) {
      seen.add(r.ppid)
      out.push(r.ppid)
      r = byPid.get(r.ppid)
    }
    return out
  }
  const deepest = (cwd: string): string | null => {
    let best: string | null = null
    for (const f of folders) if (insideFolder(cwd, f) && (best === null || f.length > best.length)) best = f
    return best
  }
  const found = new Map<number, StrayProc>()
  for (const [pid, i] of [...info].sort((a, b) => a[0] - b[0])) {
    const row = byPid.get(pid)
    if (!i.listens.length || !row || !i.cwd || sessions.has(pid) || claimed.has(pid)) continue
    const folder = deepest(i.cwd)
    if (folder === null || ancestors(pid).some((a) => sessions.has(a))) continue
    found.set(pid, { pid, command: row.command, cwd: i.cwd, ports: i.listens, startedAt: now - row.elapsed * 1000, folderOf: folder })
  }
  const out: StrayProc[] = []
  for (const s of found.values()) {
    const top = ancestors(s.pid).filter((a) => found.has(a)).pop()
    if (top === undefined) out.push(s)
    else found.get(top)!.ports = [...found.get(top)!.ports, ...s.ports]
  }
  return out.map((s) => ({ ...s, ports: uniquePorts(s.ports) })).sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
}
