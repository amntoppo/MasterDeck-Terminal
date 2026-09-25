import type { GhCacheStatus } from './types'
export function formatCost(usd: number | null): string {
  if (usd === null) return '—'
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`
}

/** A short "how long ago / how long for": 12s, 3m, 2h, 4d. */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function formatDiff(d: { added: number; removed: number; files: number } | null): string {
  if (!d || d.files === 0) return 'no changes'
  return `+${d.added} −${d.removed} · ${d.files} file${d.files === 1 ? '' : 's'}`
}

export function formatPct(pct: number | null): string {
  return pct === null ? '—' : `${Math.round(pct)}%`
}

/** Replace the home directory with ~ and keep the last `keep` path segments. */
export function shortPath(p: string, home: string, keep = 3): string {
  const withTilde = home && p.startsWith(home) ? '~' + p.slice(home.length) : p
  const parts = withTilde.split(/[\\/]/).filter(Boolean)
  if (parts.length <= keep) return withTilde
  return '…/' + parts.slice(-keep).join('/')
}

/** "just now", "1 minute ago", "15 minutes ago", "2 hours ago", "3 days ago". */
/** "GitHub cache: 80% of reads served (41 calls saved) today", or the shared pause. */
export function formatGhCache(c: GhCacheStatus | null, now: number): string | null {
  if (!c) return null
  if (c.pausedUntil && c.pausedUntil > now) {
    const at = new Date(c.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return `GitHub rate limit: every caller paused until ${at}, serving cached answers`
  }
  const saved = c.hit + c.stale
  const reads = saved + c.miss
  if (!reads) return null
  return `GitHub cache today: ${Math.round((saved / reads) * 100)}% of reads served (${saved} call${saved === 1 ? '' : 's'} saved)`
}

export function formatRefreshed(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}
