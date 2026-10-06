import type { CliResult, DraftAssign, Sprint } from '@shared/types'
import type { RunResult, Runner } from './run'
import type { Ticket } from '@shared/ticket'

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
  private exec(args: string[], stdin?: string, timeoutMs = 30_000, force = false, env: Record<string, string> = {}): Promise<RunResult> {
    return this.run(this.python, ['-m', 'master.cli', ...args], {
      stdin,
      timeoutMs,
      env: { ...env, PYTHONPATH: this.libDir, PYTHONIOENCODING: 'utf-8', ...(force ? { GHC_FORCE: '1' } : {}) },
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
    // Fresh from GitHub, as gh's active account (no GH_TOKEN/GHC_ACCOUNT: today's cache keys).
    // Setup's per-account reads use configDetectAll with the account's env instead.
    const r = await this.exec(args, undefined, 90_000, true)
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      return { ok: true, data: JSON.parse(r.stdout) }
    } catch {
      return { ok: false, message: 'config detect printed invalid JSON' }
    }
  }

  /** `master config detect --all`: every owner, their repos and boards, in two GraphQL calls. `env`: GH_TOKEN of the account asked about. */
  async configDetectAll(env: Record<string, string> = {}): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    // Fresh from GitHub; an account's env (detectEnv) carries GHC_ACCOUNT, so what it caches is that
    // account's own. No env: gh's active account, today's keys.
    const r = await this.exec(['config', 'detect', '--all'], undefined, 120_000, true, env)
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

  /**
   * `master repo-issues`: every issue of these repositories (the Board's repository view), each read
   * as its own account. The CLI reads ten repositories of an account at a time, one after the
   * other: two minutes for each started ten.
   */
  async repoIssues(repos: string[], force = false): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    const r = await this.exec(['repo-issues', '--repos', repos.join(',')], undefined, 120_000 * Math.max(1, Math.ceil(repos.length / 10)), force)
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      return { ok: true, data: JSON.parse(r.stdout) }
    } catch {
      return { ok: false, message: 'repo-issues printed invalid JSON' }
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

  /**
   * With title and url (a board card), no snapshot lookup is needed. The draft's folder is the
   * ticket's repository's checkout under its account's workspace, else that workspace (the CLI's
   * `checkout.resolve`); `cwd`: a folder the user chose instead.
   */
  async draftAssign(t: Ticket, title?: string, url?: string, cwd?: string): Promise<{ ok: true; draft: DraftAssign } | { ok: false; message: string }> {
    const extra = [...(title && url ? ['--title', title, '--url', url] : []), ...(cwd ? ['--cwd', cwd] : [])]
    const r = await this.exec(['draft-assign', String(t.number), ...(t.repo ? ['--repo', t.repo] : []), ...extra], undefined, 120_000)
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      const d = JSON.parse(r.stdout)
      return { ok: true, draft: { ...d, repo: typeof d.repo === 'string' ? d.repo : null, proposalId: null } }
    } catch {
      return { ok: false, message: 'draft-assign printed invalid JSON' }
    }
  }

  /** `master checkout <owner/name>`: where a session for that repository starts (its checkout, else its account's workspace). */
  async checkout(repo: string): Promise<{ ok: true; cwd: string; workspace: string; found: boolean; trusted: boolean | null } | { ok: false; message: string }> {
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) return { ok: false, message: 'not a repository (owner/name)' }
    const r = await this.exec(['checkout', repo])
    if (r.code !== 0) return { ok: false, message: message(r) }
    try {
      const d = JSON.parse(r.stdout)
      if (typeof d?.cwd !== 'string' || !d.cwd) return { ok: false, message: 'checkout printed an unexpected shape' }
      return { ok: true, cwd: d.cwd, workspace: typeof d.workspace === 'string' ? d.workspace : d.cwd, found: d.found === true, trusted: typeof d.trusted === 'boolean' ? d.trusted : null }
    } catch {
      return { ok: false, message: 'checkout printed invalid JSON' }
    }
  }

  /**
   * `master trust <folder>`: has Claude Code been allowed to work there (its trust prompt was
   * accepted)? The CLI reads Claude Code's own file and never writes it. `waitSeconds`: it keeps
   * looking (every two seconds) until the answer is yes or the time is over. null: not known.
   */
  async trust(folder: string, waitSeconds = 0): Promise<boolean | null> {
    if (!folder || folder.startsWith('-')) return null
    const wait = Math.min(Math.max(Math.round(waitSeconds), 0), 60)
    const r = await this.exec(['trust', folder, ...(wait ? ['--wait', String(wait)] : [])], undefined, (wait + 20) * 1000)
    if (r.code !== 0) return null
    try {
      const t = JSON.parse(r.stdout)?.trusted
      return typeof t === 'boolean' ? t : null
    } catch {
      return null
    }
  }

  approve(ids: number[]): Promise<CliResult> {
    return this.write(['approve', ...ids.map(String)])
  }

  /** `master mark <id> <status> --note -`: move a proposal on (e.g. a question the user answered). */
  mark(id: number, status: 'sent' | 'done' | 'blocked' | 'held' | 'question', note: string): Promise<CliResult> {
    return this.write(['mark', String(id), status, '--note', '-'], note)
  }

  reject(ids: number[]): Promise<CliResult> {
    return this.write(['reject', ...ids.map(String)])
  }

  /** Add an ASSIGN proposal. The prompt goes on stdin; the message is the same text. */
  async addAssign(a: { issue: number; repo?: string | null; name: string; cwd: string; prompt: string; source: string; kind?: string; model?: string; account?: string }): Promise<
    { ok: true; id: number } | { ok: false; message: string }
  > {
    const r = await this.exec(
      ['add', '--kind', a.kind ?? 'ASSIGN', '--issue', String(a.issue), ...(a.repo ? ['--repo', a.repo] : []), '--source', a.source, '--spawn-name', a.name, '--cwd', a.cwd,
        '--message', a.prompt, '--prompt', '-', ...(a.model ? ['--model', a.model] : []), ...(a.account ? ['--account', a.account] : [])],
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
