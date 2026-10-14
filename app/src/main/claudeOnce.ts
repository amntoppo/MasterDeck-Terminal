import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Runner, RunResult } from './run'

/**
 * The empty project folder `claude -p` left for a scratch directory under ~/.claude/projects
 * (Claude Code makes one even for a session it does not save). Never one with a transcript in it.
 */
export function tidyProjects(projectsDir: string | null, scratch: string): void {
  if (!projectsDir) return
  const tag = basename(scratch)
  try {
    for (const d of readdirSync(projectsDir)) {
      if (!d.endsWith(tag)) continue
      const p = join(projectsDir, d)
      const hasTranscript = (dir: string): boolean =>
        readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasTranscript(join(dir, e.name)) : e.name.endsWith('.jsonl')))
      if (!hasTranscript(p)) rmSync(p, { recursive: true, force: true })
    }
  } catch {
    // nothing to tidy
  }
}

/**
 * One `claude -p` for an app feature (CLAUDE.md): from a new empty temp folder (no project hooks,
 * no CLAUDE.md apply), no session saved, the prompt on stdin; the folder and the empty project
 * folder Claude Code made for it are removed afterwards.
 */
export async function claudeOnce(o: {
  run: Runner
  claude: string
  model: string
  prompt: string
  timeoutMs: number
  projectsDir: string | null
  /** The temp folder's prefix ("masterdeck-summary-"). */
  prefix: string
  /** Aborting kills claude (a quit, Turn off meetings); the folders are still removed. */
  signal?: AbortSignal
}): Promise<RunResult> {
  const scratch = mkdtempSync(join(tmpdir(), o.prefix))
  try {
    return await o.run(o.claude, ['-p', '--model', o.model, '--no-session-persistence'], { cwd: scratch, stdin: o.prompt, timeoutMs: o.timeoutMs, signal: o.signal })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    tidyProjects(o.projectsDir, scratch)
  }
}

/**
 * The temp folders a run cut short by a quit left (a quit may end the process before the run's own
 * clean-up): `<tmpdir>/<prefix>*` older than `olderMs` (so a run in progress keeps its folder), and
 * the empty project folders Claude Code made for them.
 */
export function tidyScratch(prefix: string, projectsDir: string | null, olderMs: number, now = Date.now(), dir = tmpdir()): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue
    const p = join(dir, n)
    try {
      const st = lstatSync(p)
      if (!st.isDirectory() || now - st.mtimeMs < olderMs) continue
      rmSync(p, { recursive: true, force: true })
    } catch {
      continue
    }
    tidyProjects(projectsDir, p)
  }
}
