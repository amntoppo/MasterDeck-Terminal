import { describe, expect, it } from 'vitest'
import { formatAgo, formatCost, formatDiff, formatPct, formatRefreshed, shortPath, formatGhCache } from './format'

describe('format', () => {
  it('cost', () => {
    expect(formatCost(null)).toBe('—')
    expect(formatCost(1.844)).toBe('$1.84')
    expect(formatCost(12.34)).toBe('$12.3')
  })
  it('ago', () => {
    expect(formatAgo(12_000)).toBe('12s')
    expect(formatAgo(3 * 60_000)).toBe('3m')
    expect(formatAgo(2 * 3600_000)).toBe('2h')
    expect(formatAgo(4 * 86400_000)).toBe('4d')
    expect(formatAgo(-5)).toBe('0s')
  })
  it('diff', () => {
    expect(formatDiff({ added: 124, removed: 37, files: 6 })).toBe('+124 −37 · 6 files')
    expect(formatDiff({ added: 1, removed: 0, files: 1 })).toBe('+1 −0 · 1 file')
    expect(formatDiff(null)).toBe('no changes')
  })
  it('pct', () => {
    expect(formatPct(62.4)).toBe('62%')
    expect(formatPct(null)).toBe('—')
  })
  it('shortPath', () => {
    expect(shortPath('/Users/a/x', '/Users/a')).toBe('~/x')
    expect(shortPath('/Users/a/p/q/.claude/worktrees/x', '/Users/a', 3)).toBe('…/.claude/worktrees/x')
  })
  it('refreshed', () => {
    expect(formatRefreshed(30_000)).toBe('just now')
    expect(formatRefreshed(60_000)).toBe('1 minute ago')
    expect(formatRefreshed(15 * 60_000)).toBe('15 minutes ago')
    expect(formatRefreshed(60 * 60_000)).toBe('1 hour ago')
    expect(formatRefreshed(5 * 3600_000)).toBe('5 hours ago')
    expect(formatRefreshed(49 * 3600_000)).toBe('2 days ago')
  })
})

describe('formatGhCache', () => {
  const base = { pausedUntil: null, pauseReason: null, hit: 0, miss: 0, stale: 0, write: 0, blocked: 0 }
  it('says nothing before any read', () => {
    expect(formatGhCache(null, 0)).toBeNull()
    expect(formatGhCache(base, 0)).toBeNull()
  })
  it('shows the share of reads the cache answered', () => {
    expect(formatGhCache({ ...base, hit: 39, stale: 1, miss: 10 }, 0)).toBe('GitHub cache today: 80% of reads served (40 calls saved)')
    expect(formatGhCache({ ...base, hit: 1, miss: 1 }, 0)).toBe('GitHub cache today: 50% of reads served (1 call saved)')
  })
  it('shows the shared pause while it lasts', () => {
    const now = Date.now()
    expect(formatGhCache({ ...base, hit: 3, pausedUntil: now + 60_000 }, now)).toMatch(/^GitHub rate limit: every caller paused until /)
    expect(formatGhCache({ ...base, hit: 3, pausedUntil: now - 1 }, now)).toMatch(/^GitHub cache today/)
  })
})
