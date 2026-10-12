import type { ChangedFile, FileDiff } from './diff'
import type { FileRefusal } from './fileView'

/** The answers of the session-file channels (`files:list`, `files:read`, `diff:list`, `diff:file`). */

export type Answer<T> = ({ ok: true } & T) | { ok: false; message: string }

export type FileList = Answer<{ paths: string[]; truncated: boolean }>
export type FileRead = Answer<{ path: string; text: string | null; refused: FileRefusal | null; bytes: number; mtimeMs: number }>
export type ChangeList = Answer<{ files: ChangedFile[] }>
export type DiffRead = Answer<{ path: string; diff: FileDiff }>

/**
 * JSON bytes an answer to the web app may take: the bridge seals and base64s it into one frame
 * (MAX_FRAME, 1.4 MB), so ~1 MB of JSON is the ceiling; keep a margin under it.
 */
export const WEB_ANSWER_MAX = 900_000

const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length

/** An answer as the web app gets it: unchanged when it fits the bridge, else cut or refused. */
export function webFit<T extends FileList | FileRead | ChangeList | DiffRead>(a: T): T {
  if (!a.ok || size(a) <= WEB_ANSWER_MAX) return a
  if ('paths' in a) {
    // The longest prefix of the list that fits.
    let lo = 0
    let hi = a.paths.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (size({ ...a, paths: a.paths.slice(0, mid), truncated: true }) <= WEB_ANSWER_MAX) lo = mid
      else hi = mid - 1
    }
    return { ...a, paths: a.paths.slice(0, lo), truncated: true }
  }
  if ('text' in a) return { ...a, text: null, refused: 'too-large' }
  if ('diff' in a) return { ok: false, message: 'This diff is too large to show in the browser. Open it on the Mac.' } as T
  if ('files' in a) return { ...a, files: a.files.slice(0, 5000) }
  return a
}
