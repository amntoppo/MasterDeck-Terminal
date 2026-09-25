import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** GitHub data kept on disk so the next launch shows tickets at once, before refreshing. */
export interface GithubCache {
  /** Raw `master snapshot` output. */
  snapshot?: unknown
  /** Raw `master board` output (before sprints: the current sprint only). */
  board?: unknown
  /** Raw `master board --sprint` output by sprint key. */
  boards?: Record<string, unknown>
  sprints?: unknown[]
  users?: unknown[]
  me?: string
  selectedSprint?: string
  boardHistory?: Record<string, unknown>
  /** Raw team PR search pages, and when they were fetched. */
  teamPrPages?: unknown[]
  teamPrsAt?: number
  /** When the cached data was last refreshed from GitHub (epoch ms). */
  refreshedAt?: number
}

export function loadCache(path: string): GithubCache {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as GithubCache) : {}
  } catch {
    return {}
  }
}

/** Atomic write (temp file + rename), so a crash mid-write never leaves a broken cache. */
export function saveCache(path: string, data: GithubCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, path)
  } catch {
    // best effort: the next refresh writes it again
  }
}
