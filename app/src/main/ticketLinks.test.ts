import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  it('reads a missing or broken file as empty', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'))
    writeFileSync(join(d, 'ticket-links.json'), '{oops')
    expect(new LinkStore(join(d, 'ticket-links.json'), join(d, 'none.json')).read().sessions).toEqual({})
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
