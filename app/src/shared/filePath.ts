/**
 * Paths inside a session's folder. `insideRoot` is the one check a path from the renderer or the
 * web goes through before main reads it (main then checks the real path too: symlinks).
 */

import { viewKind } from './fileView'

const MAX_PATH = 4096
// Plain-text extensions a bare name (no folder) may have and still be taken for a file.
const TEXT_EXT = /\.(txt|log|csv|tsv|lock|env|cfg|conf)$/i

/** A safe relative path, normalised ("a/./b/../c" → "a/c"), or null when it is not one. */
export function insideRoot(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH) return null
  if (p.includes('\0') || p.includes('\\') || p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return null
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(part)
  }
  return out.length ? out.join('/') : null
}

/**
 * A path as a session printed it (relative to its folder, or absolute inside it) as a path inside
 * the folder `root`, or null when it points anywhere else.
 */
export function relativeTo(root: string, p: string): string | null {
  const r = root.replace(/\/+$/, '')
  if (!r) return null
  if (p.startsWith('/')) return p.startsWith(`${r}/`) ? insideRoot(p.slice(r.length + 1)) : null
  return insideRoot(p)
}

export interface FoundPath {
  path: string
  line?: number
  /** Columns in the text: [start, end). */
  start: number
  end: number
}

// A path token not preceded by path or URL characters (so nothing inside a URL), then an optional
// ":line[:col]" or "(line)".
const PATH_RE = /(?<![\w./:~-])((?:\.{1,2}\/|\/)?[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)*)(?::(\d+)(?::(\d+))?|\((\d+)\))?/g

/**
 * File paths in a line of terminal text, for ⌘-click. A path needs an extension with a letter
 * ("a.ts", not "1.2.3") or a "./" start. Whether it exists is main's to say.
 */
export function findPaths(text: string): FoundPath[] {
  const found: FoundPath[] = []
  for (const m of text.matchAll(PATH_RE)) {
    let path = m[1]
    const hasSuffix = m[2] !== undefined || m[4] !== undefined
    if (!hasSuffix) path = path.replace(/\.+$/, '')
    if (!path || path.startsWith('www.')) continue
    const last = path.slice(path.lastIndexOf('/') + 1)
    if (!/\.[A-Za-z][\w-]*$/.test(last) && !path.startsWith('./')) continue
    // A bare name ("e.g", "example.com") is a file only with an extension MasterDeck knows.
    if (!path.includes('/') && viewKind(path).kind === 'text' && !TEXT_EXT.test(path)) continue
    const start = m.index ?? 0
    const line = m[2] ?? m[4]
    found.push({ path, ...(line ? { line: Number(line) } : {}), start, end: hasSuffix ? start + m[0].length : start + path.length })
  }
  return found
}
