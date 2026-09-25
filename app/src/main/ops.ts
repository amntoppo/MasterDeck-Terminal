import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { summarizeTranscript, type HistoryHit } from '@shared/history'
import { classifyWorktree, parseWorktreeList, type WorktreeInfo } from '@shared/janitor'
import { isSafeBgId } from '@shared/paneCommand'
import { issueFromBranch, type StandupCommit } from '@shared/standup'
import type { CliResult } from '@shared/types'
import type { JanitorRow, Template } from '@shared/ipc'
import type { Paths } from './paths'
import type { Runner } from './run'

export type { JanitorRow, Template }

export const BUILTIN_TEMPLATES: Template[] = [
  { name: 'TDD, small PR', text: 'Work test-first: write a failing test, make it pass, refactor. Keep the change small and focused, and open one small PR.', builtin: true },
  { name: 'Investigate only', text: 'Investigate only: find the cause and report your findings with file:line references. Do not change any code or open a PR.', builtin: true },
  { name: 'Fix and open PR', text: 'Fix it, add a test that covers the fix, run the tests, then open a PR and babysit it. Do not merge.', builtin: true },
  { name: 'Pair with me', text: 'Pair with me: propose each step and wait for my OK before you make changes.', builtin: true },
]

/**
 * Run a pipeline in its own process group, so a timeout kills every process in it (find, xargs and
 * the greps), not just the shell.
 */
function runGroup(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: out })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: out })
    })
  })
}

/** Board, standup, janitor, history and template operations that need the filesystem or git. */
export class Ops {
  constructor(
    private run: Runner,
    private paths: Paths,
    private claude: () => string,
  ) {}

  private git(dir: string, args: string[], timeoutMs = 15_000) {
    return this.run('git', ['-C', dir, ...args], { timeoutMs })
  }

  /**
   * Move a ticket on the board through babysit-ticket, without touching any real session: a
   * temporary TT_STATE_DIR holds a synthetic link for the issue, and `tt.sh set --force` moves it.
   */
  async setStatus(issue: number, status: string): Promise<CliResult> {
    if (!Number.isInteger(issue) || issue <= 0) return { ok: false, message: 'bad issue number' }
    if (!existsSync(this.paths.babysitTt)) return { ok: false, message: `babysit-ticket not found at ${this.paths.babysitTt}` }
    const dir = mkdtempSync(join(tmpdir(), 'masterdeck-tt-'))
    const fake = '00000000-0000-4000-8000-masterdeck00'
    try {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ sessions: { [fake]: { issue, title: '', branch: '', linked_at: new Date().toISOString(), prs: [] } }, branches: {} }))
      const r = await this.run('bash', [this.paths.babysitTt, 'set', status, '--force'], {
        cwd: dir,
        timeoutMs: 60_000,
        env: { TT_STATE_DIR: dir, TT_SESSION: fake, TT_CWD: dir },
      })
      const out = (r.stdout.trim() || r.stderr.trim()).split('\n').filter(Boolean)
      return r.code === 0 ? { ok: true, message: out.at(-1) ?? `#${issue} → ${status}` } : { ok: false, message: out.at(-1) ?? `exit ${r.code}` }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * Git repos directly under the workspace root: the workspace folder itself, or, when the
   * workspace is a repo of its own, the folder it sits in (its sibling repos).
   */
  repos(): string[] {
    const ws = this.paths.masterWorkspace
    const root = existsSync(join(ws, '.git')) ? dirname(ws) : ws
    try {
      return readdirSync(root)
        .map((d) => join(root, d))
        .filter((d) => existsSync(join(d, '.git')))
    } catch {
      return []
    }
  }

  /** My commits since `since` in the given dirs (repos or worktrees), deduplicated by sha. */
  /** My commits authored in [sinceMs, untilMs) in the repos of the given dirs, deduplicated by sha. */
  async standupCommits(sinceMs: number, dirs: string[], untilMs = Date.now() + 60_000): Promise<StandupCommit[]> {
    const since = new Date(sinceMs).toISOString()
    const seen = new Set<string>()
    const out: StandupCommit[] = []
    // Worktrees share their repo's history: one `git log --all` per repository, not per folder.
    const repos = new Map<string, string>()
    await Promise.all(
      [...new Set(dirs)].filter((d) => d && existsSync(d)).map(async (d) => {
        const r = await this.git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        const common = r.stdout.trim()
        if (r.code === 0 && common && !repos.has(common)) repos.set(common, dirname(common))
      }),
    )
    const logs = await Promise.all(
      [...repos.values()].map(async (dir) => {
        const email = (await this.git(dir, ['config', 'user.email'])).stdout.trim()
        if (!email) return null
        const r = await this.git(dir, ['log', '--all', '--source', `--since=${since}`, `--author=${email}`, '--format=%H%x09%at%x09%S%x09%s'], 30_000)
        return r.code === 0 ? { dir, out: r.stdout } : null
      }),
    )
    for (const l of logs) {
      if (!l) continue
      const dir = l.dir
      // --since filters on the commit date, which a rebase resets; keep only work *authored* since then.
      for (const line of l.out.split('\n')) {
        const [sha, at, source, ...rest] = line.split('\t')
        if (!sha || seen.has(sha) || Number(at) * 1000 < sinceMs || Number(at) * 1000 >= untilMs) continue
        if (/^Merge\b/.test(rest.join('\t'))) continue
        seen.add(sha)
        const branch = (source ?? '').replace(/^refs\/(heads|remotes\/origin)\//, '') || null
        out.push({ repo: basename(dir.replace(/\/\.claude\/worktrees\/[^/]+$/, '')), sha, subject: rest.join('\t'), branch, issue: issueFromBranch(branch) })
      }
    }
    return out
  }

  /** One worktree's facts, from git. A failed `git status` reads as dirty (-1), never as clean. */
  private async inspect(repo: string, w: { path: string; branch: string | null; head: string | null }, base: string): Promise<WorktreeInfo> {
    const status = await this.git(w.path, ['status', '--porcelain'])
    const dirtyFiles = status.code === 0 ? status.stdout.split('\n').filter(Boolean).length : -1
    const merged = (await this.git(repo, ['merge-base', '--is-ancestor', w.head ?? 'HEAD', base])).code === 0
    const pushed = w.branch ? (await this.git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${w.branch}`])).code === 0 : false
    const orphan = w.branch ? 0 : (await this.git(w.path, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes'])).stdout.trim()
    const last = Number((await this.git(w.path, ['log', '-1', '--format=%ct'])).stdout.trim())
    return {
      repo,
      path: w.path,
      branch: w.branch,
      dirtyFiles,
      merged,
      pushed,
      orphanCommits: Number(orphan) || 0,
      lastCommitAt: Number.isFinite(last) && last > 0 ? last * 1000 : null,
    }
  }

  private async baseRef(repo: string): Promise<string> {
    return (await this.git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).stdout.trim() || 'refs/remotes/origin/main'
  }

  /** Every worktree under <repo>/.claude/worktrees, classified with the worktree-janitor rules. */
  async janitor(liveDirs: string[]): Promise<JanitorRow[]> {
    const rows: JanitorRow[] = []
    for (const repo of this.repos()) {
      const list = await this.git(repo, ['worktree', 'list', '--porcelain'])
      if (list.code !== 0) continue
      const base = await this.baseRef(repo)
      for (const w of parseWorktreeList(list.stdout)) {
        // Sibling checkouts that are themselves worktrees list the same set again: once per path.
        if (!w.path.includes('/.claude/worktrees/') || !existsSync(w.path) || rows.some((r) => r.path === w.path)) continue
        const info = await this.inspect(repo, w, base)
        rows.push({ ...info, ...classifyWorktree(info, liveDirs) })
      }
    }
    return rows
  }

  /**
   * Remove a worktree directory (never its branch), then prune. Checked here, not just in the UI:
   * the path must sit directly in one of our repos' .claude/worktrees; it is re-classified now (a
   * session may have started there since the scan); IN USE is refused; `force` only for DIRTY or
   * UNPUSHED (the typed-confirm classes), and those are refused without it.
   */
  async removeWorktree(repo: string, path: string, force: boolean, liveDirs: string[]): Promise<CliResult> {
    let realRepo: string
    let realPath: string
    try {
      realRepo = realpathSync(repo)
      realPath = realpathSync(path)
    } catch {
      return { ok: false, message: 'that worktree no longer exists' }
    }
    if (!this.repos().some((r) => { try { return realpathSync(r) === realRepo } catch { return false } })) return { ok: false, message: 'not one of the workspace repos' }
    if (dirname(realPath) !== join(realRepo, '.claude', 'worktrees')) return { ok: false, message: 'not a .claude worktree of that repo' }
    const list = await this.git(realRepo, ['worktree', 'list', '--porcelain'])
    const w = parseWorktreeList(list.stdout).find((x) => { try { return realpathSync(x.path) === realPath } catch { return false } })
    if (!w) return { ok: false, message: 'git does not list that worktree' }
    const { cls, reason } = classifyWorktree(await this.inspect(realRepo, { ...w, path: realPath }, await this.baseRef(realRepo)), liveDirs)
    if (cls === 'IN USE') return { ok: false, message: `refused: ${reason}` }
    const confirmClass = cls === 'DIRTY' || cls === 'UNPUSHED'
    if (confirmClass && !force) return { ok: false, message: `refused: ${cls} (${reason}); confirm to remove` }
    const r = await this.git(realRepo, ['worktree', 'remove', ...(confirmClass ? ['--force'] : []), realPath], 60_000)
    await this.git(realRepo, ['worktree', 'prune'])
    return r.code === 0 ? { ok: true, message: `removed ${basename(realPath)}` } : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) }
  }

  /** Remove a parked background session (`claude rm`); its transcript stays on disk. */
  async removeSession(bgId: string): Promise<CliResult> {
    if (!isSafeBgId(bgId)) return { ok: false, message: 'bad background id' }
    const r = await this.run(this.claude(), ['rm', bgId], { timeoutMs: 30_000 })
    return r.code === 0 ? { ok: true, message: `removed ${bgId}` } : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) }
  }

  /** Full-text search over every transcript: fixed string, case-insensitive; newest 40 sessions. */
  async searchHistory(query: string): Promise<HistoryHit[]> {
    const q = query.trim()
    if (q.length < 2) return []
    const files = await this.matchingTranscripts(q)
    const withTime = files
      .map((f) => {
        try {
          return { f, t: statSync(f).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { f: string; t: number } => !!x)
      // Session transcripts only: subagent transcripts (agent-*.jsonl) can't be opened or resumed.
      .filter((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(basename(x.f)))
      .sort((a, b) => b.t - a.t)
      .slice(0, 40)
    const hits: HistoryHit[] = []
    for (let i = 0; i < withTime.length; i += 8) {
      const batch = await Promise.all(withTime.slice(i, i + 8).map(async ({ f, t }) => summarizeTranscript(basename(f, '.jsonl'), f, await this.relevantLines(f, q), q, t)))
      for (const h of batch) if (h) hits.push(h)
    }
    return hits.sort((a, b) => b.lastActivity - a.lastActivity)
  }

  /** The lines of a transcript that matter for a hit: the first (cwd), titles, and matches. */
  private async relevantLines(f: string, q: string): Promise<string[]> {
    if (process.platform !== 'win32') {
      const r = await this.run('grep', ['-Fi', '-e', q, '-e', '"custom-title"', '-e', '"ai-title"', '--', f], { timeoutMs: 30_000 })
      const first = await this.run('head', ['-c', '65536', f], { timeoutMs: 10_000 })
      return [...first.stdout.split('\n').slice(0, 5), ...r.stdout.split('\n')]
    }
    const lines: string[] = []
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) lines.push(line)
    return lines
  }

  /** Transcript files containing `q`: system grep where there is one, else a streaming scan. */
  private async matchingTranscripts(q: string): Promise<string[]> {
    const dir = this.paths.projectsDir
    if (process.platform !== 'win32') {
      // 8 greps in parallel (about 5x faster on a 1 GB+ projects dir). The folder and query are
      // positional arguments to sh, never spliced into the script.
      const script = 'find "$1" -name "*.jsonl" -print0 | xargs -0 -P 8 -n 50 grep -lFi -- "$2"'
      const r = await runGroup('sh', ['-c', script, 'sh', dir, q], 120_000)
      if (r.code === 0 || r.code === 1 || r.code === 123) return r.stdout.split('\n').filter((l) => l.endsWith('.jsonl'))
    }
    const out: string[] = []
    const needle = q.toLowerCase()
    for (const p of readdirSync(dir)) {
      let names: string[] = []
      try {
        names = readdirSync(join(dir, p)).filter((n) => n.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const n of names) {
        const f = join(dir, p, n)
        const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity })
        for await (const line of rl) {
          if (line.toLowerCase().includes(needle)) {
            out.push(f)
            rl.close()
            break
          }
        }
      }
    }
    return out
  }

  private get templatesPath(): string {
    return join(this.paths.home, 'templates.json')
  }

  templates(): Template[] {
    let saved: Template[] = []
    try {
      const raw = JSON.parse(readFileSync(this.templatesPath, 'utf8'))
      if (Array.isArray(raw)) saved = raw.filter((t) => t && typeof t.name === 'string' && typeof t.text === 'string')
    } catch {
      // none saved yet
    }
    return [...BUILTIN_TEMPLATES, ...saved]
  }

  saveTemplate(t: Template): Template[] {
    const saved = this.templates().filter((x) => !x.builtin && x.name !== t.name)
    saved.push({ name: t.name.slice(0, 60), text: t.text })
    mkdirSync(this.paths.home, { recursive: true })
    writeFileSync(this.templatesPath, JSON.stringify(saved, null, 2))
    return this.templates()
  }

  deleteTemplate(name: string): Template[] {
    const saved = this.templates().filter((x) => !x.builtin && x.name !== name)
    mkdirSync(this.paths.home, { recursive: true })
    writeFileSync(this.templatesPath, JSON.stringify(saved, null, 2))
    return this.templates()
  }
}


