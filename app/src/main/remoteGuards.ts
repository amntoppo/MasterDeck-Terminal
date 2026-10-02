import { resolve } from 'node:path'

/**
 * A remote save merges over the full current settings (a malformed payload changes nothing) and never changes
 * remoteEnabled (settings saves replace the whole object).
 */
export function remoteSettings(patch: unknown, current: object): Record<string, unknown> {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {}
  return { ...current, ...p, remoteEnabled: (current as { remoteEnabled?: unknown }).remoteEnabled }
}

/** Only dirs the deck already knows (workspace repos, session cwds); path.resolve normalises trailing slashes and `..`. */
export function knownDirsOnly(dirs: string[], known: Iterable<string>): string[] {
  const ok = new Set([...known].map((d) => resolve(d)))
  return dirs.map((d) => resolve(d)).filter((d) => ok.has(d))
}
