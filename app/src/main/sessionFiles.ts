import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { parseChanges, parseDiff } from '@shared/diff'
import { insideRoot } from '@shared/filePath'
import { BINARY_SNIFF, FILE_MAX_BYTES, FILE_MAX_LINES, limitOf, messageFor, type FileRefusal } from '@shared/fileView'
import type { Answer, ChangeList, DiffRead, FileList, FileRead } from '@shared/sessionFiles'
import type { DiffBase } from '@shared/sessionTabs'
import { defaultBranch } from './defaultBranch'
import type { Runner } from './run'

/**
 * Read-only views of a session's folder for its file and diff tabs: the files in it, one file's
 * text, the changed files and one file's diff. The root is always the session's own folder (the
 * caller looks it up by session key); paths are checked twice: `insideRoot`, then the real path
 * after links.
 */

export const LIST_MAX = 50_000
const WALK_DEPTH = 6
/** Untracked files listed in the Diff list (an unignored build folder can hold thousands); `more` counts the rest. */
export const UNTRACKED_MAX = 300
/** Files read at once to count an untracked file's lines (a launchd app may open only 256). */
const COUNT_AT_ONCE = 8
/** A tracked file larger than this is not diffed: git would send all of it, every pull. */
const DIFF_FILE_MAX_BYTES = 10_000_000
/** Folders never read by name, whatever the session's folder is. */
const NEVER_READ = new Set(['.git', '.ssh', '.gnupg', '.aws'])
const GIT_MS = 10_000
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const z = (s: string) => s.split('\0').filter(Boolean)

export class SessionFiles {
  constructor(
    private run: Runner,
    private home = homedir(),
  ) {}

  private git(root: string, ...args: string[]) {
    // No optional locks: never take the index lock from under the session's own git. Literal
    // pathspecs: a file named `[id].tsx` is that file, not a glob.
    return this.run('git', ['--no-pager', ...args], { cwd: root, timeoutMs: GIT_MS, env: { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' } })
  }

  private async isRepo(root: string): Promise<boolean> {
    return (await this.git(root, 'rev-parse', '--is-inside-work-tree')).stdout.trim() === 'true'
  }

  async list(root: string): Promise<FileList> {
    if (!(await isDir(root))) return { ok: false, message: 'The folder is not there' }
    if (await this.isRepo(root)) {
      const r = await this.git(root, 'ls-files', '-co', '--exclude-standard', '-z')
      if (r.code !== 0) return { ok: false, message: gitError(r.stderr) }
      const deleted = new Set(z((await this.git(root, 'ls-files', '-d', '-z')).stdout))
      const paths = [...new Set(z(r.stdout))].filter((p) => !deleted.has(p)).sort()
      return { ok: true, paths: paths.slice(0, LIST_MAX), truncated: paths.length > LIST_MAX }
    }
    // A session in the home folder (no project): walking it would crawl ~/Library and set off
    // macOS privacy prompts.
    const [realRoot, realHome] = await Promise.all([realpath(root).catch(() => root), realpath(this.home).catch(() => this.home)])
    if (realRoot === realHome) return { ok: false, message: 'This session works in your home folder: open a session in a project to see its files.' }
    const paths: string[] = []
    let truncated = false
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (truncated) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const p = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (depth < WALK_DEPTH) await walk(join(dir, e.name), p, depth + 1)
        } else if (e.isFile()) {
          if (paths.length >= LIST_MAX) {
            truncated = true
            return
          }
          paths.push(p)
        }
      }
    }
    await walk(root, '', 1)
    return { ok: true, paths: paths.sort(), truncated }
  }

  async read(root: string, rel: string): Promise<FileRead> {
    const path = insideRoot(rel)
    if (!path) return { ok: false, message: 'Not a path in this folder' }
    const answer = (refused: FileRefusal | null, text: string | null = null, bytes = 0, mtimeMs = 0): FileRead => ({ ok: true, path, text, refused, bytes, mtimeMs })
    if (path.split('/').some((part) => NEVER_READ.has(part))) return answer('outside')
    const where = await resolveInside(root, path)
    if (where === 'missing' || where === 'outside') return answer(where)
    const st = await stat(where).catch(() => null)
    if (!st) return answer('missing')
    if (!st.isFile()) return answer('not-file')
    if (st.size > FILE_MAX_BYTES) return answer('too-large', null, st.size, st.mtimeMs)
    const buf = await readBytes(where, st.size)
    if (!buf) return answer('missing')
    const binary = buf.subarray(0, BINARY_SNIFF).includes(0)
    const text = binary ? '' : buf.toString('utf8')
    const refused = limitOf({ bytes: st.size, lines: binary ? 0 : countLines(text), binary })
    return refused ? answer(refused, null, st.size, st.mtimeMs) : answer(null, text, st.size, st.mtimeMs)
  }

  /** The commit a base compares against, or a message. */
  private async baseRev(root: string, base: DiffBase): Promise<Answer<{ rev: string }>> {
    if (!(await this.isRepo(root))) return { ok: false, message: 'Not a git repository' }
    const head = await this.git(root, 'rev-parse', '--verify', '-q', 'HEAD')
    if (base === 'uncommitted') return { ok: true, rev: head.code === 0 ? 'HEAD' : EMPTY_TREE }
    const b = await defaultBranch(this.run, root)
    if (!b || head.code !== 0) return { ok: false, message: 'No default branch found' }
    for (const ref of [`origin/${b}`, b]) {
      const r = await this.git(root, 'merge-base', 'HEAD', ref)
      if (r.code === 0 && r.stdout.trim()) return { ok: true, rev: r.stdout.trim() }
    }
    return { ok: false, message: 'No default branch found' }
  }

  async changes(root: string, base: DiffBase): Promise<ChangeList> {
    const rev = await this.baseRev(root, base)
    if (!rev.ok) return rev
    const flags = ['diff', rev.rev, '-M', '-z', '--relative', '--no-ext-diff', '--no-textconv', '--no-color']
    const [names, nums, others] = await Promise.all([
      this.git(root, ...flags, '--name-status'),
      this.git(root, ...flags, '--numstat'),
      this.git(root, 'ls-files', '--others', '--exclude-standard', '-z'),
    ])
    const failed = [names, nums, others].find((r) => r.code !== 0)
    if (failed) return { ok: false, message: gitError(failed.stderr) }
    const all = z(others.stdout).sort()
    const untracked = await mapLimited(all.slice(0, UNTRACKED_MAX), COUNT_AT_ONCE, async (p) => {
      const r = await this.read(root, p)
      return { path: p, add: r.ok && r.text !== null ? countLines(r.text) : 0, binary: r.ok && r.refused === 'binary' }
    })
    const more = Math.max(0, all.length - UNTRACKED_MAX)
    return { ok: true, files: parseChanges(names.stdout, nums.stdout, untracked), ...(more ? { more } : {}) }
  }

  async fileDiff(root: string, rel: string, base: DiffBase): Promise<DiffRead> {
    const path = insideRoot(rel)
    if (!path) return { ok: false, message: 'Not a path in this folder' }
    const rev = await this.baseRev(root, base)
    if (!rev.ok) return rev
    const untracked = await this.git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', path)
    if (z(untracked.stdout).includes(path)) {
      const r = await this.read(root, path)
      if (!r.ok) return r
      if (r.refused === 'binary') return { ok: true, path, diff: { binary: true, hunks: [], truncated: false } }
      if (r.text === null) return { ok: false, message: messageFor(r.refused ?? 'missing') }
      if (!r.text) return { ok: true, path, diff: { binary: false, hunks: [], truncated: false } }
      const lines = r.text.replace(/\n$/, '').split('\n')
      return { ok: true, path, diff: parseDiff(`@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`) }
    }
    // A renamed file is diffed against its old path, so the diff shows the edit, not a whole new file.
    const where = await resolveInside(root, path)
    if (where === 'outside') return { ok: false, message: messageFor('outside') }
    const size = where === 'missing' ? 0 : ((await stat(where).catch(() => null))?.size ?? 0)
    if (size > DIFF_FILE_MAX_BYTES) return { ok: false, message: 'This file is too large to diff here.' }
    const flags = [rev.rev, '-M', '--relative', '--no-ext-diff', '--no-textconv', '--no-color']
    const names = await this.git(root, 'diff', ...flags, '--name-status', '-z')
    const st = z(names.stdout)
    let from: string | null = null
    for (let i = 0; i < st.length; i++) {
      if (/^[RC]/.test(st[i]) && st[i + 2] === path) from = st[i + 1]
      if (/^[RC]/.test(st[i])) i += 2
      else i += 1
    }
    const r = await this.git(root, 'diff', ...flags, '--', ...(from ? [from, path] : [path]))
    if (r.code !== 0) return { ok: false, message: gitError(r.stderr) }
    return { ok: true, path, diff: parseDiff(r.stdout) }
  }
}

function gitError(stderr: string): string {
  const line = stderr.trim().split('\n').find(Boolean)
  return line ? `git: ${line.replace(/^(fatal|error): /, '')}` : 'git failed'
}

function countLines(text: string): number {
  if (!text) return 0
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0 && n <= FILE_MAX_LINES + 1; i = text.indexOf('\n', i + 1)) n++
  return text.endsWith('\n') ? n : n + 1
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false
}

/** The real path of root/rel when it stays inside root's real path. */
async function resolveInside(root: string, rel: string): Promise<string | 'missing' | 'outside'> {
  const realRoot = await realpath(root).catch(() => null)
  if (!realRoot) return 'missing'
  const real = await realpath(join(realRoot, rel)).catch(() => null)
  if (!real) return 'missing'
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep) ? real : 'outside'
}

async function readBytes(p: string, size: number): Promise<Buffer | null> {
  const fh = await open(p, 'r').catch(() => null)
  if (!fh) return null
  try {
    const buf = Buffer.alloc(size)
    const { bytesRead } = await fh.read(buf, 0, size, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** `fn` over `items`, at most `n` at a time, answers in order. */
async function mapLimited<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}
