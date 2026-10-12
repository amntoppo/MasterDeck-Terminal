import { DIFF_MAX_LINES } from './fileView'

/** Parsers for git's answers: the changed files of a session's folder, and one file's diff. */

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface ChangedFile {
  path: string
  /** Where a renamed (or copied) file came from. */
  oldPath?: string
  status: ChangeStatus
  add: number
  del: number
  binary: boolean
  /** Not known to git yet (counted as added). */
  untracked?: boolean
}

const STATUS: Record<string, ChangeStatus> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted', R: 'renamed', C: 'added' }

/**
 * `git diff <base> -M --name-status -z` and `git diff <base> -M --numstat -z` (the same diff),
 * plus the untracked files main counted itself. Sorted by path.
 */
export function parseChanges(nameStatus: string, numstat: string, untracked: { path: string; add: number; binary: boolean }[]): ChangedFile[] {
  const counts = new Map<string, { add: number; del: number; binary: boolean }>()
  const nt = numstat.split('\0')
  for (let i = 0; i < nt.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(nt[i])
    if (!m) continue
    let path = m[3]
    // A rename: an empty path, then the old and the new path as their own fields.
    if (!path) {
      path = nt[i + 2] ?? ''
      i += 2
    }
    const binary = m[1] === '-'
    counts.set(path, { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary })
  }
  const out: ChangedFile[] = []
  const st = nameStatus.split('\0')
  for (let i = 0; i < st.length; i++) {
    const code = st[i]?.[0]
    const status = code ? STATUS[code] : undefined
    if (!status) continue
    let oldPath: string | undefined
    let path = st[i + 1]
    i++
    if (code === 'R' || code === 'C') {
      oldPath = path
      path = st[i + 1]
      i++
    }
    if (!path) continue
    const c = counts.get(path) ?? { add: 0, del: 0, binary: false }
    out.push({ path, ...(oldPath !== undefined ? { oldPath } : {}), status, ...c })
  }
  for (const u of untracked) out.push({ path: u.path, status: 'added', add: u.binary ? 0 : u.add, del: 0, binary: u.binary, untracked: true })
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export type DiffLine =
  | { kind: 'ctx'; text: string; old: number; new: number; noNewline?: boolean }
  | { kind: 'del'; text: string; old: number; noNewline?: boolean }
  | { kind: 'add'; text: string; new: number; noNewline?: boolean }

export interface Hunk {
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  binary: boolean
  hunks: Hunk[]
  /** More than DIFF_MAX_LINES lines: the rest is not drawn. */
  truncated: boolean
}

/** One file's unified diff (git diff, or git diff --no-index for an untracked file). */
export function parseDiff(text: string): FileDiff {
  const hunks: Hunk[] = []
  let hunk: Hunk | null = null
  let binary = false
  let count = 0
  let truncated = false
  let oldN = 0
  let newN = 0
  let seenFile = false
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!m) continue
      if (count >= DIFF_MAX_LINES) {
        truncated = true
        break
      }
      oldN = Number(m[1])
      newN = Number(m[2])
      hunk = { header: line, lines: [] }
      hunks.push(hunk)
      continue
    }
    if (line.startsWith('diff --git ')) {
      // One file per answer: a second section (a pathspec that matched more) is not this file's.
      if (seenFile) break
      seenFile = true
      hunk = null
      continue
    }
    if (!hunk) {
      if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') binary = true
      continue
    }
    const c = line[0]
    if (c === '\\') {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
      continue
    }
    if (c !== ' ' && c !== '+' && c !== '-') continue
    if (count >= DIFF_MAX_LINES) {
      truncated = true
      break
    }
    count++
    const body = line.slice(1)
    if (c === ' ') hunk.lines.push({ kind: 'ctx', text: body, old: oldN++, new: newN++ })
    else if (c === '-') hunk.lines.push({ kind: 'del', text: body, old: oldN++ })
    else hunk.lines.push({ kind: 'add', text: body, new: newN++ })
  }
  return { binary, hunks, truncated }
}

export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/** A hunk as old | new rows: context on both sides, a run of removed lines beside the added run after it. */
export function splitRows(h: Hunk): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    dels = []
    adds = []
  }
  for (const l of h.lines) {
    if (l.kind === 'ctx') {
      flush()
      rows.push({ left: l, right: l })
    } else if (l.kind === 'del') {
      if (adds.length) flush()
      dels.push(l)
    } else adds.push(l)
  }
  flush()
  return rows
}
