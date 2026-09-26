import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import { isSafeBgId, paneCommand } from '@shared/paneCommand'
import type { PaneSpec } from '@shared/types'
import type { PtyOpenResult } from '@shared/ipc'

const REPLAY_MAX = 200 * 1024

interface Pane {
  proc: pty.IPty | null
  buffer: string
  /** Total characters emitted so far; lets a view drop data already in its replay. */
  seq: number
  exited: boolean
}

/**
 * One PTY per pane id. Tabs keep their PTY while they exist so switching tabs keeps scrollback;
 * the output so far is replayed when a terminal view mounts again. Closing a pane kills only the
 * `claude attach` process; the background session keeps running.
 */
export class PtyManager {
  private panes = new Map<string, Pane>()

  constructor(
    private env: () => NodeJS.ProcessEnv,
    private send: (channel: string, ...args: unknown[]) => void,
    private claude: () => string,
  ) {}

  open(id: string, spec: PaneSpec, cols: number, rows: number): PtyOpenResult {
    const existing = this.panes.get(id)
    if (existing) {
      // An exited pane stays exited until the user asks to reattach (close, then open). A view
      // that remounts must not silently start a new `claude attach`, which resumes a parked session.
      if (!existing.exited) this.resize(id, cols, rows)
      return { ok: true, replay: existing.buffer, seq: existing.seq, exited: existing.exited }
    }
    const testNoMaster = process.env.MASTERDECK_TEST_NO_MASTER_ATTACH === '1' && id.startsWith('master:')
    if (spec.kind === 'attach' && (process.env.MASTERDECK_TEST_NO_ATTACH === '1' || testNoMaster)) {
      return { ok: false, replay: '', seq: 0, exited: true, message: 'attach disabled for this test run' }
    }
    if (spec.kind === 'attach' && !isSafeBgId(spec.bgId)) {
      return { ok: false, replay: '', seq: 0, exited: true, message: `refusing unsafe background id ${spec.bgId}` }
    }
    const cmd = paneCommand(spec, process.platform, process.env.SHELL, this.claude())
    const pane: Pane = { proc: null, buffer: '', seq: 0, exited: false }
    this.panes.set(id, pane)
    try {
      const proc = pty.spawn(cmd.file, cmd.args, {
        name: 'xterm-256color',
        cols: Math.max(cols, 2),
        rows: Math.max(rows, 2),
        cwd: startDir(cmd.cwd),
        env: { ...this.env(), TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
      })
      pane.proc = proc
      // A closed pane's process can still emit while a new pane reuses its id; drop those events.
      const current = () => this.panes.get(id) === pane
      proc.onData((d) => {
        if (!current()) return
        pane.buffer = (pane.buffer + d).slice(-REPLAY_MAX)
        pane.seq += d.length
        this.send(`pty:data:${id}`, d, pane.seq)
      })
      proc.onExit(({ exitCode }) => {
        pane.exited = true
        pane.proc = null
        if (current()) this.send(`pty:exit:${id}`, exitCode)
      })
      return { ok: true, replay: '', seq: 0, exited: false }
    } catch (e) {
      pane.exited = true
      return { ok: false, replay: '', seq: 0, exited: true, message: `could not start ${cmd.file}: ${String(e)}` }
    }
  }

  /** The last output of a pane (for spotting a prompt before typing into it). */
  tail(id: string, chars = 8000): string {
    return this.panes.get(id)?.buffer.slice(-chars) ?? ''
  }

  /** A pane whose process is still running. */
  isAlive(id: string): boolean {
    const p = this.panes.get(id)
    return !!p && !p.exited && !!p.proc
  }

  write(id: string, data: string): void {
    this.panes.get(id)?.proc?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.panes.get(id)?.proc?.resize(Math.max(cols, 2), Math.max(rows, 2))
    } catch {
      // resizing an exiting pty throws; harmless
    }
  }

  close(id: string): void {
    const p = this.panes.get(id)
    this.panes.delete(id)
    try {
      p?.proc?.kill()
    } catch {
      // already gone
    }
  }

  closeAll(): void {
    for (const id of [...this.panes.keys()]) this.close(id)
  }
}

/** Where a terminal starts: `~` expanded; home when the folder is missing (a node-pty spawn would fail). */
export function startDir(cwd: string | undefined): string {
  const home = homedir()
  const dir = cwd?.replace(/^~(?=$|[\\/])/, home)
  return dir && existsSync(dir) ? dir : home
}
