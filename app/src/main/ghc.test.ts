import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ghErrorText, makeGhRunner, readGhCacheStatus } from './ghc'
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

describe('ghc force', () => {
  it('sets GHC_FORCE only when asked', async () => {
    const envs: (string | undefined)[] = []
    const gh = makeGhRunner(async (_c, _a, opts) => (envs.push(opts?.env?.GHC_FORCE), { code: 0, stdout: '', stderr: '' }), '/lib', 'python3', 'darwin')
    await gh(['api', 'user'], { ttl: 60, force: true })
    await gh(['api', 'user'], { ttl: 60 })
    expect(envs).toEqual(['1', undefined])
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

describe('ghErrorText', () => {
  it('never reads a successful answer body (comments can say "rate limit")', () => {
    expect(ghErrorText({ code: 0, stdout: '{"data":{"body":"we hit the rate limit"}}', stderr: '' })).toBe('')
    expect(ghErrorText({ code: 1, stdout: 'x', stderr: 'HTTP 403: API rate limit exceeded' })).toContain('rate limit')
    expect(ghErrorText({ code: 0, stdout: JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'm' }] }), stderr: '' })).toContain('rate limit')
    expect(ghErrorText({ code: 0, stdout: JSON.stringify({ errors: [{ type: 'NOT_FOUND', message: 'rate limit' }] }), stderr: '' })).toBe('')
    // gh exits 1 on a partial GraphQL error but still prints the data: its bodies are never read.
    const partial = { code: 1, stdout: JSON.stringify({ data: { p0: { pullRequest: { body: 'rate limit again' } }, p1: null }, errors: [{ type: 'NOT_FOUND', message: 'no repo' }] }), stderr: 'gh: Could not resolve to a Repository' }
    expect(ghErrorText(partial)).toBe('gh: Could not resolve to a Repository')
    expect(ghErrorText({ code: 1, stdout: 'API rate limit exceeded', stderr: '' })).toContain('rate limit')
  })
})

describe('ghc per account', () => {
  it("adds the account's GH_TOKEN and GHC_ACCOUNT, or refuses with its reason", async () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = []
    const fake = async (_c: string, _a: string[], opts?: RunOpts) => (envs.push(opts?.env), { code: 0, stdout: 'ok', stderr: '' })
    const bob = makeGhRunner(fake, '/lib', 'python3', 'darwin', () => ({ env: { GH_TOKEN: 't-bob', GHC_ACCOUNT: 'bob-work' } }))
    await bob(['api', 'user'])
    expect(envs[0]).toMatchObject({ GH_TOKEN: 't-bob', GHC_ACCOUNT: 'bob-work', PYTHONPATH: '/lib' })
    const gone = makeGhRunner(fake, '/lib', 'python3', 'darwin', () => ({ error: 'GitHub account bob-work needs to log in again' }))
    expect(await gone(['api', 'user'])).toEqual({ code: 1, stdout: '', stderr: 'GitHub account bob-work needs to log in again' })
    expect(envs).toHaveLength(1)
    const win = makeGhRunner(fake, '/lib', 'python', 'win32', () => ({ env: { GH_TOKEN: 't-bob', GHC_ACCOUNT: 'bob-work' } }))
    await win(['api', 'user'])
    expect(envs[1]).toEqual({ GH_TOKEN: 't-bob', GHC_ACCOUNT: 'bob-work' })
    const plain = makeGhRunner(fake, '/lib', 'python3', 'darwin')
    await plain(['api', 'user'])
    expect(envs[2]?.GH_TOKEN).toBeUndefined()
  })
  it("shows any account's pause", () => {
    const d = mkdtempSync(join(tmpdir(), 'ghc-'))
    const now = 1_790_000_000_000
    writeFileSync(join(d, 'paused-bob-work.json'), JSON.stringify({ until: now / 1000 + 600, reason: 'bob limit' }))
    writeFileSync(join(d, 'paused.json'), JSON.stringify({ until: now / 1000 + 300, reason: 'rate limit' }))
    expect(readGhCacheStatus(d, now, true)).toMatchObject({ pausedUntil: now + 600_000, pauseReason: 'bob limit' })
  })
  it("one account: another login's leftover pause is ignored; paused.json and a token's own pause count", () => {
    const d = mkdtempSync(join(tmpdir(), 'ghc-'))
    const now = 1_790_000_000_000
    writeFileSync(join(d, 'paused-bob-work.json'), JSON.stringify({ until: now / 1000 + 600, reason: 'bob limit' }))
    expect(readGhCacheStatus(d, now, false).pausedUntil).toBeNull()
    expect(readGhCacheStatus(d, now).pausedUntil).toBeNull()
    writeFileSync(join(d, 'paused.json'), JSON.stringify({ until: now / 1000 + 300, reason: 'rate limit' }))
    expect(readGhCacheStatus(d, now, false)).toMatchObject({ pausedUntil: now + 300_000, pauseReason: 'rate limit' })
    // GH_TOKEN in MasterDeck's own env (ghcache keys it on a hash of the token): still shown.
    writeFileSync(join(d, 'paused--t0123456789abcdef.json'), JSON.stringify({ until: now / 1000 + 900, reason: 'token limit' }))
    expect(readGhCacheStatus(d, now, false)).toMatchObject({ pausedUntil: now + 900_000, pauseReason: 'token limit' })
  })
})
