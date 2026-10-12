import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { outline, summaryPrompt, type SessionSummary } from '@shared/summary'
import { claudeOnce } from './claudeOnce'
import type { Runner } from './run'

/** A cheap, quick model is plenty for a summary. */
const MODEL = 'haiku'

export class Summaries {
  private busy = new Set<string>()

  constructor(
    private run: Runner,
    private claude: () => string,
    private dir: string,
    /** ~/.claude/projects: Claude Code makes a folder there even for a session it doesn't save. */
    private projectsDir: string | null = null,
  ) {}

  private file(sessionId: string): string | null {
    return /^[0-9a-f-]{36}$/i.test(sessionId) ? join(this.dir, `${sessionId}.json`) : null
  }

  get(sessionId: string): SessionSummary | null {
    const f = this.file(sessionId)
    if (!f) return null
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as SessionSummary
    } catch {
      return null
    }
  }

  /**
   * Summarize a session from its transcript: an outline of it, the branch's changes and its PRs go
   * to a one-off `claude -p` (no session saved, run from an empty folder so no project hooks apply).
   */
  async make(o: { sessionId: string; name: string; transcript: string; cwd: string | null; issue: string | null; prs: string[] }): Promise<{ ok: true; summary: SessionSummary } | { ok: false; message: string }> {
    const f = this.file(o.sessionId)
    if (!f) return { ok: false, message: 'bad session id' }
    if (this.busy.has(o.sessionId)) return { ok: false, message: 'already summarizing' }
    this.busy.add(o.sessionId)
    try {
      const size = statSync(o.transcript).size
      const body = outline(readFileSync(o.transcript, 'utf8').split('\n'))
      if (!body.trim()) return { ok: false, message: 'nothing to summarize yet' }
      let diffStat = ''
      if (o.cwd && existsSync(o.cwd)) {
        const base = await this.run('git', ['-C', o.cwd, 'merge-base', 'HEAD', 'origin/HEAD'], { timeoutMs: 10_000 })
        if (base.code === 0) {
          const d = await this.run('git', ['-C', o.cwd, 'diff', '--stat', base.stdout.trim()], { timeoutMs: 15_000 })
          if (d.code === 0) diffStat = d.stdout.trim().split('\n').slice(-25).join('\n')
        }
      }
      const r = await claudeOnce({
        run: this.run,
        claude: this.claude(),
        model: MODEL,
        prompt: summaryPrompt(o.name, o.issue, o.prs, diffStat, body),
        timeoutMs: 180_000,
        projectsDir: this.projectsDir,
        prefix: 'masterdeck-summary-',
      })
      const text = r.stdout.trim()
      if (r.code !== 0 || !text) return { ok: false, message: (r.stderr || r.stdout || `claude exited ${r.code}`).trim().slice(0, 300) }
      const summary: SessionSummary = { sessionId: o.sessionId, text, at: Date.now(), size, model: MODEL }
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(`${f}.tmp`, JSON.stringify(summary, null, 2))
      renameSync(`${f}.tmp`, f)
      return { ok: true, summary }
    } catch (e) {
      return { ok: false, message: String(e) }
    } finally {
      this.busy.delete(o.sessionId)
    }
  }
}
