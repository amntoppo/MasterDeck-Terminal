import { resolve } from 'node:path'

/** A remote client may never turn remote access off (or on) for itself. */
export function stripRemoteSettings<T extends Record<string, unknown>>(patch: T): Omit<T, 'remoteEnabled'> {
  const { remoteEnabled: _drop, ...rest } = patch
  return rest
}

/** Only dirs the deck already knows (workspace repos, live session cwds); resolve() drops trailing slashes and `..`. */
export function knownDirsOnly(dirs: string[], known: Iterable<string>): string[] {
  const ok = new Set([...known].map((d) => resolve(d)))
  return dirs.map((d) => resolve(d)).filter((d) => ok.has(d))
}
