import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GhCacheStatus } from '@shared/types'
import type { RunOpts, RunResult, Runner } from './run'

/** `gh <args>` through the shared GitHub cache (master's ghcache): same output as gh. */
export type GhRunner = (args: string[], opts?: RunOpts & { ttl?: number }) => Promise<RunResult>

export function makeGhRunner(run: Runner, libDir: string, python: string, platform = process.platform): GhRunner {
  // ghcache locks with fcntl, which Windows lacks: there, call gh directly.
  if (platform === 'win32') return (args, { ttl: _ttl, ...opts } = {}) => run('gh', args, opts)
  return (args, { ttl, ...opts } = {}) =>
    run(python, ['-m', 'master.ghcache', '--ttl', String(ttl ?? 60), ...args], {
      ...opts,
      env: { ...(opts.env ?? {}), PYTHONPATH: libDir, PYTHONIOENCODING: 'utf-8' },
    })
}

export type { GhCacheStatus }

export function ghCacheDir(): string {
  return process.env.GH_CACHE_DIR || join(homedir(), '.claude', 'gh-cache')
}

export function readGhCacheStatus(dir = ghCacheDir(), now = Date.now()): GhCacheStatus {
  const json = (f: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      return {}
    }
  }
  const p = json('paused.json')
  const until = typeof p.until === 'number' ? p.until * 1000 : 0
  const s = json('stats.json')
  const n = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : 0)
  return {
    pausedUntil: until > now ? until : null,
    pauseReason: until > now && typeof p.reason === 'string' ? p.reason : null,
    hit: n('hit'),
    miss: n('miss'),
    stale: n('stale'),
    write: n('write'),
    blocked: n('blocked'),
  }
}
