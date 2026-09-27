/**
 * The git worktrees a session created or worked in, read from its transcript: EnterWorktree (its
 * path, or "Created worktree at …"), `git worktree add <path>` in a Bash command, and the
 * session's own working directory. Candidates only; main checks each is a real linked worktree.
 */

export interface WorktreeScan {
  /** Absolute candidate paths, oldest first, no repeats. */
  paths: string[]
}

export interface SessionWorktree {
  path: string
  /** The main checkout's folder name (the repo). */
  repo: string
  branch: string | null
}

export const newWorktreeScan = (): WorktreeScan => ({ paths: [] })

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const WORKTREE_OPTS_WITH_VALUE = new Set(['-b', '-B', '--reason', '--orphan'])

function join(base: string, p: string, home: string): string {
  const exp = p.replace(/^~(?=$|\/)/, home)
  if (/^[A-Za-z]:[\\/]/.test(exp) || /^[A-Za-z]:[\\/]/.test(base)) return exp // Windows: left as written
  if (exp.startsWith('/')) return normalize(exp)
  return normalize(`${base.replace(/\/+$/, '')}/${exp}`)
}

function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/, '$2')

/** Paths of `git worktree add` in a shell command, resolved against its `cd` / `-C` or `cwd`. */
export function worktreeAddPaths(command: string, cwd: string, home: string): string[] {
  const out: string[] = []
  let base = cwd
  for (const seg of command.split(/&&|;|\|\||\n/)) {
    const words = seg.trim().match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g)?.map(unquote) ?? []
    if (words[0] === 'cd' && words[1]) {
      base = join(base, words[1], home)
      continue
    }
    const g = words.indexOf('git')
    if (g < 0) continue
    let i = g + 1
    let dir = base
    while (words[i] === '-C' && words[i + 1]) {
      dir = join(dir, words[i + 1], home)
      i += 2
    }
    if (words[i] !== 'worktree' || words[i + 1] !== 'add') continue
    for (let j = i + 2; j < words.length; j++) {
      const w = words[j]
      if (WORKTREE_OPTS_WITH_VALUE.has(w)) j++
      else if (w.startsWith('-')) continue
      else {
        out.push(join(dir, w, home))
        break
      }
    }
  }
  return out
}

/** Add the worktree candidates in these transcript lines to `scan`. */
export function scanWorktreeLines(lines: string[], scan: WorktreeScan, home: string): void {
  const add = (p: string) => {
    if (p && !scan.paths.includes(p)) scan.paths.push(p)
  }
  for (const line of lines) {
    if (!line.includes('"cwd"') && !line.includes('orktree')) continue
    let d: Obj
    try {
      d = obj(JSON.parse(line))
    } catch {
      continue
    }
    if (d.isSidechain === true) continue
    const cwd = str(d.cwd)
    if (cwd.includes('/.claude/worktrees/') || cwd.includes('/worktrees/')) add(normalize(cwd))
    const m = obj(d.message)
    if (!Array.isArray(m.content)) continue
    for (const b of m.content.map(obj)) {
      if (b.type === 'tool_use') {
        const input = obj(b.input)
        if (b.name === 'EnterWorktree' && str(input.path)) add(join(cwd || home, str(input.path), home))
        if (b.name === 'Bash' && str(input.command).includes('worktree')) for (const p of worktreeAddPaths(str(input.command), cwd || home, home)) add(p)
      } else if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => str(obj(c).text)).join('\n') : ''
        const hit = /Created worktree at (\S+?)(?: on branch|\.?\s|$)/.exec(text)
        if (hit) add(normalize(hit[1]))
      }
    }
  }
}
