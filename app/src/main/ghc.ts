import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GhCacheStatus } from '@shared/types'
import type { AccountRunEnv } from './accountEnv'
import type { RunOpts, RunResult, Runner } from './run'

/** `gh <args>` through the shared GitHub cache (master's ghcache): same output as gh. `force` skips cached answers. */
export type GhRunner = (args: string[], opts?: RunOpts & { ttl?: number; force?: boolean }) => Promise<RunResult>

/** `account`: the runner of one GitHub account (its GH_TOKEN and GHC_ACCOUNT on every call, or why it can't call). */
export function makeGhRunner(run: Runner, libDir: string, python: string, platform = process.platform, account?: () => AccountRunEnv): GhRunner {
  const withAccount = (go: (env: Record<string, string>) => Promise<RunResult>): Promise<RunResult> => {
    const a = account?.()
    if (a && 'error' in a) return Promise.resolve({ code: 1, stdout: '', stderr: a.error })
    return go(a?.env ?? {})
  }
  // ghcache locks with fcntl, which Windows lacks: there, call gh directly.
  if (platform === 'win32')
    return (args, { ttl: _ttl, force: _force, ...opts } = {}) =>
      withAccount((env) => run('gh', args, Object.keys(env).length ? { ...opts, env: { ...(opts.env ?? {}), ...env } } : opts))
  return (args, { ttl, force, ...opts } = {}) =>
    withAccount((env) =>
      run(python, ['-m', 'master.ghcache', '--ttl', String(ttl ?? 60), ...args], {
        ...opts,
        env: { ...(opts.env ?? {}), PYTHONPATH: libDir, PYTHONIOENCODING: 'utf-8', ...(force ? { GHC_FORCE: '1' } : {}), ...env },
      }),
    )
}

/**
 * What of a gh answer may be checked for a rate limit: stderr, the body only when gh failed, and a
 * GraphQL `RATE_LIMITED` error. Never a good answer's body: PR comments can say "rate limit".
 */
export function ghErrorText(r: Pick<RunResult, 'code' | 'stdout' | 'stderr'>): string {
  let json: unknown
  try {
    json = JSON.parse(r.stdout)
  } catch {
    // not JSON: a failed gh's stdout is its message
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [r.stderr, r.code !== 0 ? r.stdout : ''].filter(Boolean).join('\n')
  // A JSON answer (gh exits 1 on a partial GraphQL error but prints the data): only its error types count.
  const errs = (json as { errors?: { type?: unknown }[] }).errors
  const limited = Array.isArray(errs) && errs.some((e) => e?.type === 'RATE_LIMITED')
  return [r.stderr, limited ? 'GraphQL: API rate limit exceeded (RATE_LIMITED)' : ''].filter(Boolean).join('\n')
}

/** gh failed, or printed GraphQL `data` anyway (a partial error): the PRs in it can be read. */
export function ghHasData(r: Pick<RunResult, 'code' | 'stdout'>): boolean {
  if (r.code === 0) return true
  try {
    const d = (JSON.parse(r.stdout) as { data?: unknown })?.data
    return !!d && typeof d === 'object'
  } catch {
    return false
  }
}

export type { GhCacheStatus }

export function ghCacheDir(): string {
  return process.env.GH_CACHE_DIR || join(homedir(), '.claude', 'gh-cache')
}

/**
 * The shared pause and today's counters. `multi` (two or more accounts): any account's pause counts.
 * One account: only paused.json, and the pause of a GH_TOKEN without GHC_ACCOUNT (`paused--t<hash>`),
 * never a leftover `paused-<login>.json` from when several accounts were connected.
 */
export function readGhCacheStatus(dir = ghCacheDir(), now = Date.now(), multi = false): GhCacheStatus {
  const json = (f: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      return {}
    }
  }
  let until = 0
  let reason: string | null = null
  let names: string[] = []
  try {
    const pat = multi ? /^paused(-[A-Za-z0-9-]{1,39})?\.json$/ : /^paused(--t[0-9a-f]{16})?\.json$/
    names = readdirSync(dir).filter((f) => pat.test(f))
  } catch {
    // no cache folder yet
  }
  for (const f of names) {
    const p = json(f)
    const u = typeof p.until === 'number' ? p.until * 1000 : 0
    if (u > until) {
      until = u
      reason = typeof p.reason === 'string' ? p.reason : null
    }
  }
  const s = json('stats.json')
  const n = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : 0)
  return {
    pausedUntil: until > now ? until : null,
    pauseReason: until > now ? reason : null,
    hit: n('hit'),
    miss: n('miss'),
    stale: n('stale'),
    write: n('write'),
    blocked: n('blocked'),
  }
}
