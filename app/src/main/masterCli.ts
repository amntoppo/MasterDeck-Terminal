import type { CliResult, DraftAssign, Sprint } from '@shared/types'
import type { RunResult, Runner } from './run'

function message(r: RunResult): string {
  // The CLI prints its errors on stdout; Python tracebacks land on stderr.
  return (r.stdout.trim() || r.stderr.trim() || `exit ${r.code}`).slice(0, 500)
}

/** The `master` CLI, run as `python -m master.cli` so it works without bash (Windows). */
export class MasterCli {
  constructor(
    private run: Runner,
    private libDir: string,
    private python: string,
  ) {}

  /** `force` (a manual Refresh) makes GitHub reads skip what the shared gh cache already holds. */
  private exec(args: string[], stdin?: string, timeoutMs = 30_000, force = false): Promise<RunResult> {
    return this.run(this.python, ['-m', 'master.cli', ...args], {
      stdin,
      timeoutMs,
      env: { PYTHONPATH: this.libDir, PYTHONIOENCODING: 'utf-8', ...(force ? { GHC_FORCE: '1' } : {}) },
    })
  }

  private async write(args: string[], stdin?: string): Promise<CliResult> {
    const r = await this.exec(args, stdin)
    return { ok: r.code === 0, message: message(r) }
  }

  /** `master config detect`: what GitHub has for an owner (repos, projects, a project's statuses). */
  async configDetect(owner: string, project?: number): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) return { ok: false, message: 'not a GitHub login' }
    const args = ['config', 'detect', '--owner', owner, ...(project && Number.isInteger(project) && project > 0 ? ['--project', String(project)] : [])]
    const r = await this.exec(args, undefined, 90_000)
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      return { ok: true, data: JSON.parse(r.stdout) }
    } catch {
      return { ok: false, message: 'config detect printed invalid JSON' }
    }
  }

  /** `master config save`: merge these settings into ~/.claude/master/config.json. */
  configSave(patch: unknown): Promise<CliResult> {
    return this.write(['config', 'save'], JSON.stringify(patch ?? {}))
  }

  /** `master snapshot`: network heavy (gh, board, agents), a few seconds. */
  async snapshot(force = false): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    const r = await this.exec(['snapshot'], undefined, 120_000, force)
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      return { ok: true, data: JSON.parse(r.stdout) }
    } catch {
      return { ok: false, message: 'snapshot printed invalid JSON' }
    }
  }

  /** `master board`: the current sprint board with PR details (two GitHub calls). */
  async board(sprint = '@current', force = false): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    const r = await this.exec(['board', '--sprint', sprint], undefined, 120_000, force)
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      return { ok: true, data: JSON.parse(r.stdout) }
    } catch {
      return { ok: false, message: 'board printed invalid JSON' }
    }
  }

  /** `master sprints`: every sprint of the project, newest first. */
  async sprints(force = false): Promise<{ ok: true; sprints: Sprint[] } | { ok: false; message: string }> {
    const r = await this.exec(['sprints'], undefined, 60_000, force)
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      const raw = JSON.parse(r.stdout)
      if (!Array.isArray(raw)) return { ok: false, message: 'sprints printed an unexpected shape' }
      return { ok: true, sprints: raw.filter((x) => x && typeof x.title === 'string') }
    } catch {
      return { ok: false, message: 'sprints printed invalid JSON' }
    }
  }

  /** With title and url (a board card), no snapshot lookup is needed. */
  async draftAssign(issue: number, title?: string, url?: string): Promise<{ ok: true; draft: DraftAssign } | { ok: false; message: string }> {
    const extra = title && url ? ['--title', title, '--url', url] : []
    const r = await this.exec(['draft-assign', String(issue), ...extra], undefined, 120_000)
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      return { ok: true, draft: { ...JSON.parse(r.stdout), proposalId: null } }
    } catch {
      return { ok: false, message: 'draft-assign printed invalid JSON' }
    }
  }

  approve(ids: number[]): Promise<CliResult> {
    return this.write(['approve', ...ids.map(String)])
  }

  reject(ids: number[]): Promise<CliResult> {
    return this.write(['reject', ...ids.map(String)])
  }

  /** Add an ASSIGN proposal. The prompt goes on stdin; the message is the same text. */
  async addAssign(a: { issue: number; name: string; cwd: string; prompt: string; source: string; kind?: string }): Promise<
    { ok: true; id: number } | { ok: false; message: string }
  > {
    const r = await this.exec(
      ['add', '--kind', a.kind ?? 'ASSIGN', '--issue', String(a.issue), '--source', a.source, '--spawn-name', a.name, '--cwd', a.cwd,
        '--message', a.prompt, '--prompt', '-'],
      a.prompt,
    )
    const m = /added (\d+)/.exec(r.stdout)
    if (r.code === 0 && m) return { ok: true, id: Number(m[1]) }
    return { ok: false, message: message(r) }
  }

  /**
   * `master spawn <id>`: start an approved spawn proposal's session now (`claude --bg`) and mark
   * it sent, under the ledger lock, so master can't spawn it a second time.
   */
  spawn(id: number): Promise<CliResult> {
    return this.write(['spawn', String(id)])
  }

  /** `master say --to <name>`: master-agent relays the text to that session with SendMessage. */
  say(to: string, text: string): Promise<CliResult> {
    return this.write(['say', '-', '--to', to], text)
  }

  /** Ask master-agent to run a sweep (it arrives through `master watch`). */
  sweepRequest(): Promise<CliResult> {
    return this.write(['sweep-request'])
  }
}
