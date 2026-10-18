import { existsSync, statSync } from 'node:fs'
import type { Runner } from './run'
import { readTail } from './files'
import {
  cleanOutput,
  EXITED_KEEP_MS,
  findStrays,
  parseLsof,
  parsePs,
  PS_ARGS,
  sessionGroups,
  taskIdOf,
  transcriptTasks,
  uniquePorts,
  type LsofInfo,
  type ProcsAll,
  type ProcsAnswer,
  type SessionProc,
  type TranscriptTasks,
} from '@shared/sessionProcs'

/** What the collector needs to know about a session. */
export interface ProcsSession {
  key: string
  /** Its `claude` process; null: not running. */
  pid: number | null
  transcript: string | null
}

/** A session for `listAll`: its `claude` process (null: not running), its folder and worktrees. */
export interface ProcsAllSession {
  key: string
  pid: number | null
  cwd: string | null
  worktrees: string[]
}

interface Seen {
  /** Shell pids seen for it: the process groups whose leftovers are still its own. */
  groups: Set<number>
  /** Last answer's processes by pid, with where their output goes. */
  last: Map<number, SessionProc & { outPath: string | null; taskId: string | null }>
  /** Ones that ended, shown with their exit code until EXITED_KEEP_MS has passed. */
  ended: Map<number, SessionProc & { taskId: string | null }>
  at: number
  /** The transcript's task ids, read again when it changes. */
  tasks: { path: string; mtime: number; tasks: TranscriptTasks } | null
}

const OUTPUT_BYTES = 12 * 1024
// By path: lsof is in /usr/sbin, which the PATH a GUI app gets may leave out.
const PS = existsSync('/bin/ps') ? '/bin/ps' : 'ps'
const LSOF = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof'
/** A session no one asked about for this long is forgotten. */
const FORGET_MS = 60 * 60 * 1000

/**
 * A session's running processes, read when the Details panel asks (`procs:list`): one `ps` for the
 * process table, two `lsof` calls for the folders, stdouts and listening sockets of its processes.
 * ponytail: what a shell leaves running is found by its process group only if MasterDeck saw the
 * shell (Details open while it ran); a `nohup cmd &` from a shell that came and went unseen is
 * missed. A periodic table read for every session would close that, at a `ps` per tick.
 */
export class SessionProcs {
  private seen = new Map<string, Seen>()

  constructor(
    private run: Runner,
    private platform: NodeJS.Platform = process.platform,
    private now: () => number = Date.now,
  ) {}

  async list(s: ProcsSession): Promise<ProcsAnswer> {
    if (this.platform === 'win32') return { ok: true, supported: false }
    const now = this.now()
    this.forget(now)
    const seen = this.seen.get(s.key) ?? { groups: new Set(), last: new Map(), ended: new Map(), at: now, tasks: null }
    this.seen.set(s.key, seen)
    seen.at = now
    let running: SessionProc[] = []
    const fresh = new Map<number, SessionProc & { outPath: string | null; taskId: string | null }>()
    if (s.pid !== null) {
      const ps = await this.run(PS, PS_ARGS, { timeoutMs: 5000 })
      if (ps.code !== 0) return { ok: false, message: `ps failed: ${(ps.stderr || ps.stdout).trim().slice(0, 200)}` }
      const groups = sessionGroups(parsePs(ps.stdout), s.pid, seen.groups, now)
      for (const g of groups) if (g.shell) seen.groups.add(g.pid)
      const pids = groups.flatMap((g) => g.pids)
      const info = await this.lsof(pids)
      const tasks = this.tasks(seen, s.transcript)
      for (const g of groups) {
        const lead = info.get(g.pid)
        const outPath = lead?.out ?? null
        const taskId = taskIdOf(outPath ?? undefined)
        const p: SessionProc = {
          pid: g.pid,
          command: g.command,
          kind: !g.shell ? 'detached' : taskId && tasks?.background.has(taskId) ? 'background' : 'foreground',
          cwd: lead?.cwd ?? g.pids.map((x) => info.get(x)?.cwd).find(Boolean) ?? null,
          startedAt: g.startedAt,
          state: 'running',
          exitCode: null,
          endedAt: null,
          ports: uniquePorts(g.pids.flatMap((x) => info.get(x)?.listens ?? [])),
          cpu: g.cpu,
          memKb: g.memKb,
          children: g.children,
          hasOutput: !!outPath,
        }
        fresh.set(g.pid, { ...p, outPath, taskId })
        running.push(p)
      }
    }
    // What was running last time and is gone now has ended. A foreground call's result is in the
    // conversation already: it drops off at once.
    for (const [pid, p] of seen.last)
      if (!fresh.has(pid) && !seen.ended.has(pid) && p.kind !== 'foreground')
        seen.ended.set(pid, { ...p, state: 'exited', endedAt: now, ports: [], cpu: 0, memKb: 0, children: [], hasOutput: false })
    seen.last = fresh
    for (const [pid, p] of seen.ended) if (now - (p.endedAt ?? now) > EXITED_KEEP_MS || fresh.has(pid)) seen.ended.delete(pid)
    // Its notification may come a moment after the process is gone: asked again each time.
    if ([...seen.ended.values()].some((p) => p.exitCode === null)) {
      const exit = this.tasks(seen, s.transcript)?.exit
      for (const p of seen.ended.values()) {
        const code = p.exitCode === null && p.taskId ? exit?.get(p.taskId) : undefined
        if (code !== undefined) p.exitCode = code
      }
    }
    const ended = [...seen.ended.values()].map(({ taskId: _t, ...p }) => p)
    running = running.sort((a, b) => a.startedAt - b.startedAt)
    return { ok: true, supported: true, running: s.pid !== null, procs: [...running, ...ended.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))] }
  }

  /**
   * Every listed session's running processes and the strays in their folders (`procs:all`, the
   * Dashboard): one `ps`, one `lsof` for the listening sockets on the machine, one `lsof` for the
   * folders and stdouts of the sessions' processes and the listeners. Never exited rows, and it
   * only reads `seen` (the groups list() saw), so Details → Processes is unchanged by it.
   * ponytail: no transcript is read, so a shell is `background` when its stdout is a task output
   * file (recent Claude Code versions write a foreground call's there too); Details has the exact kind.
   */
  async listAll(sessions: ProcsAllSession[]): Promise<ProcsAll> {
    const at = this.now()
    if (this.platform === 'win32' || !sessions.length) return { at, sessions: {}, strays: [] }
    const [ps, socks] = await Promise.all([
      this.run(PS, PS_ARGS, { timeoutMs: 5000 }),
      this.run(LSOF, ['-nP', '-w', '-iTCP', '-sTCP:LISTEN', '-Fpcfn'], { timeoutMs: 5000 }),
    ])
    const rows = ps.code === 0 ? parsePs(ps.stdout) : []
    const listens = parseLsof(socks.stdout)
    const live = rows.length ? sessions.filter((s) => s.pid !== null) : []
    const groups = new Map(live.map((s) => [s.key, sessionGroups(rows, s.pid!, new Set(this.seen.get(s.key)?.groups), at)]))
    const pids = new Set([...groups.values()].flatMap((gs) => gs.flatMap((g) => g.pids)))
    for (const [pid, i] of listens) if (i.listens.length) pids.add(pid)
    const files = pids.size
      ? parseLsof((await this.run(LSOF, ['-nP', '-w', '-a', '-d', 'cwd,1', '-p', [...pids].sort((a, b) => a - b).join(','), '-Fpftn'], { timeoutMs: 5000 })).stdout)
      : new Map<number, LsofInfo>()
    for (const [pid, i] of listens) {
      const had = files.get(pid)
      if (had) had.listens.push(...i.listens)
      else files.set(pid, i)
    }
    const out: Record<string, SessionProc[]> = {}
    for (const s of sessions)
      out[s.key] = (groups.get(s.key) ?? [])
        .map((g): SessionProc => {
          const lead = files.get(g.pid)
          return {
            pid: g.pid,
            command: g.command,
            kind: !g.shell ? 'detached' : taskIdOf(lead?.out) ? 'background' : 'foreground',
            cwd: lead?.cwd ?? g.pids.map((x) => files.get(x)?.cwd).find(Boolean) ?? null,
            startedAt: g.startedAt,
            state: 'running',
            exitCode: null,
            endedAt: null,
            ports: uniquePorts(g.pids.flatMap((x) => files.get(x)?.listens ?? [])),
            cpu: g.cpu,
            memKb: g.memKb,
            children: g.children,
            // Its output is read through list() (Details), which keeps the paths.
            hasOutput: false,
          }
        })
        .sort((a, b) => a.startedAt - b.startedAt)
    const folders = [...new Set(sessions.flatMap((s) => [s.cwd, ...s.worktrees]).filter((f): f is string => !!f))]
    return { at, sessions: out, strays: findStrays(rows, files, folders, live.map((s) => s.pid!), at) }
  }

  /** The last few KB a process of this session wrote, when its stdout is a file (only one the last list found). */
  output(key: string, pid: number): { ok: true; text: string } | { ok: false; message: string } {
    const p = this.seen.get(key)?.last.get(pid)
    if (!p) return { ok: false, message: 'That process is not running.' }
    if (!p.outPath) return { ok: false, message: 'Its output goes straight to Claude Code; there is nothing to read here.' }
    const tail = readTail(p.outPath, OUTPUT_BYTES)
    if (!tail) return { ok: false, message: 'Could not read its output.' }
    const lines = cleanOutput(tail.text).split('\n')
    if (!tail.fromStart) lines.shift()
    return { ok: true, text: lines.join('\n').trimEnd() }
  }

  /** The transcript's last 256 KB, read only when it changed. */
  private tasks(seen: Seen, path: string | null): TranscriptTasks | null {
    if (!path) return null
    let mtime: number
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      return null
    }
    if (seen.tasks?.path === path && seen.tasks.mtime === mtime) return seen.tasks.tasks
    const tail = readTail(path, 256 * 1024)
    if (!tail) return null
    const lines = tail.text.split('\n')
    if (!tail.fromStart) lines.shift()
    seen.tasks = { path, mtime, tasks: transcriptTasks(lines) }
    return seen.tasks.tasks
  }

  private async lsof(pids: number[]): Promise<Map<number, LsofInfo>> {
    const out = new Map<number, LsofInfo>()
    if (!pids.length) return out
    const list = pids.join(',')
    // lsof exits 1 when one of the pids has nothing to list; its output still counts.
    const [files, socks] = await Promise.all([
      this.run(LSOF, ['-nP', '-w', '-a', '-p', list, '-d', 'cwd,1', '-Fpftn'], { timeoutMs: 5000 }),
      this.run(LSOF, ['-nP', '-w', '-a', '-iTCP', '-sTCP:LISTEN', '-p', list, '-Fpfn'], { timeoutMs: 5000 }),
    ])
    for (const [pid, i] of parseLsof(files.stdout)) out.set(pid, i)
    for (const [pid, i] of parseLsof(socks.stdout)) {
      const had = out.get(pid)
      if (had) had.listens.push(...i.listens)
      else out.set(pid, i)
    }
    return out
  }

  private forget(now: number): void {
    for (const [k, v] of this.seen) if (now - v.at > FORGET_MS) this.seen.delete(k)
  }
}
