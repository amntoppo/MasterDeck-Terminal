import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeGhRunner, readGhCacheStatus } from './ghc'
import type { RunOpts } from './run'

describe('ghc bridge', () => {
  it('runs gh through master.ghcache with the ttl and PYTHONPATH', async () => {
    const calls: { cmd: string; args: string[]; opts?: RunOpts }[] = []
    const gh = makeGhRunner(async (cmd, args, opts) => (calls.push({ cmd, args, opts }), { code: 0, stdout: '', stderr: '' }), '/lib', 'python3', 'darwin')
    await gh(['pr', 'view', 'u', '--json', 'state'], { ttl: 120, cwd: '/w' })
    expect(calls[0].cmd).toBe('python3')
    expect(calls[0].args).toEqual(['-m', 'master.ghcache', '--ttl', '120', 'pr', 'view', 'u', '--json', 'state'])
    expect(calls[0].opts?.env?.PYTHONPATH).toBe('/lib')
    expect(calls[0].opts?.cwd).toBe('/w')
  })
  it('reads the shared pause and counters', () => {
    const d = mkdtempSync(join(tmpdir(), 'ghc-'))
    const now = 1_790_000_000_000
    writeFileSync(join(d, 'paused.json'), JSON.stringify({ until: now / 1000 + 300, reason: 'rate limit' }))
    writeFileSync(join(d, 'stats.json'), JSON.stringify({ day: 'x', hit: 7, miss: 2 }))
    expect(readGhCacheStatus(d, now)).toEqual({ pausedUntil: now + 300_000, pauseReason: 'rate limit', hit: 7, miss: 2, stale: 0, write: 0, blocked: 0 })
    expect(readGhCacheStatus(d, now + 400_000).pausedUntil).toBeNull()
    expect(readGhCacheStatus(join(d, 'missing'), now)).toMatchObject({ pausedUntil: null, hit: 0 })
  })
})

describe('ghc on Windows', () => {
  it('calls gh directly (ghcache needs fcntl)', async () => {
    const calls: string[][] = []
    const gh = makeGhRunner(async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: '', stderr: '' }), '/lib', 'python', 'win32')
    await gh(['api', 'user'], { ttl: 60 })
    expect(calls).toEqual([['gh', 'api', 'user']])
  })
})
