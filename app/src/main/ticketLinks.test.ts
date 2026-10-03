import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig, setConfig } from '@shared/appConfig'
import { makeRunner } from './run'
import { branchKey, LinkStore } from './ticketLinks'

setConfig(parseConfig({ owner: 'acme', issueRepo: 'tracker' }))
const A = '11111111-1111-4111-8111-111111111111'

describe('LinkStore', () => {
  it('imports tt.sh state once, then keeps its own file', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'))
    const legacy = join(d, 'state.json')
    writeFileSync(legacy, JSON.stringify({ sessions: { [A]: { issue: 12, title: 't', branch: '', linked_at: '2026-10-01T00:00:00Z', prs: [] } }, branches: {} }))
    const s = new LinkStore(join(d, 'ticket-links.json'), legacy)
    expect(s.importOnce(5)).toBe(true)
    expect(s.importOnce(6)).toBe(false)
    const own = JSON.parse(readFileSync(join(d, 'ticket-links.json'), 'utf8'))
    expect(own.importedAt).toBe(5)
    expect(own.sessions[A].issue).toBe(12)
    // After the import tt.sh's file is never read again.
    writeFileSync(legacy, JSON.stringify({ sessions: { [A]: { issue: 99, title: '', branch: '', linked_at: '2026-10-09T00:00:00Z', prs: [] } }, branches: {} }))
    expect(s.read().sessions[A].issue).toBe(12)
  })
  it('links and records PRs without ever writing the legacy file', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'))
    const legacy = join(d, 'state.json')
    writeFileSync(legacy, '{"sessions":{},"branches":{}}')
    const s = new LinkStore(join(d, 'ticket-links.json'), legacy)
    s.link(A, { repo: null, number: 7 }, 'title', '')
    s.addPr(A, 'https://github.com/acme/web/pull/9')
    expect(s.read().sessions[A]).toMatchObject({ issue: 7, prs: ['https://github.com/acme/web/pull/9'] })
    expect(readFileSync(legacy, 'utf8')).toBe('{"sessions":{},"branches":{}}')
  })
  it('reads a missing file as empty', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'))
    expect(new LinkStore(join(d, 'ticket-links.json'), join(d, 'none.json')).read().sessions).toEqual({})
  })
  it('moves a corrupt file aside before linking, never overwriting it', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'))
    const file = join(d, 'ticket-links.json')
    writeFileSync(file, '{oops')
    new LinkStore(file, join(d, 'none.json')).link(A, { repo: null, number: 7 }, 't', '')
    const bak = readdirSync(d).filter((n) => n.startsWith('ticket-links.corrupt.'))
    expect(bak).toHaveLength(1)
    expect(readFileSync(join(d, bak[0]), 'utf8')).toBe('{oops')
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions[A].issue).toBe(7)
  })
  it('does not re-import from tt.sh over a corrupt own file', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'))
    const file = join(d, 'ticket-links.json')
    const legacy = join(d, 'state.json')
    writeFileSync(legacy, JSON.stringify({ sessions: { [A]: { issue: 12, title: '', branch: '', linked_at: '', prs: [] } }, branches: {} }))
    writeFileSync(file, '{oops')
    const s = new LinkStore(file, legacy)
    expect(s.importOnce(5)).toBe(false)
    expect(s.read().sessions).toEqual({})
    expect(readdirSync(d).some((n) => n.startsWith('ticket-links.corrupt.'))).toBe(true)
    expect(s.importOnce(6)).toBe(false)
  })
  it('keeps the last good links when the file turns unreadable', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'))
    const file = join(d, 'ticket-links.json')
    const s = new LinkStore(file, join(d, 'none.json'))
    s.link(A, { repo: null, number: 7 }, 't', '')
    writeFileSync(file, '{oops')
    expect(s.read().sessions[A].issue).toBe(7)
  })
  it('does not stamp the import when tt.sh is unreadable, but does when it is absent', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'))
    const legacy = join(d, 'state.json')
    writeFileSync(legacy, '{half')
    const s = new LinkStore(join(d, 'ticket-links.json'), legacy)
    expect(s.importOnce(5)).toBe(false)
    expect(existsSync(join(d, 'ticket-links.json'))).toBe(false)
    expect(new LinkStore(join(d, 'ticket-links.json'), join(d, 'none.json')).importOnce(5)).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('branchKey', () => {
  it('keys feature branches only', async () => {
    const d = mkdtempSync(join(tmpdir(), 'bk-'))
    const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('remote', 'add', 'origin', 'git@github.com:Acme/web.git')
    git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x')
    const run = makeRunner(() => process.env)
    expect(await branchKey(run, d)).toBe('')
    git('checkout', '-q', '-b', 'feat/12-x')
    expect(await branchKey(run, d)).toBe('Acme/web@feat/12-x')
  }, 20_000)
})
