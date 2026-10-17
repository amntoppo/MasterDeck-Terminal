import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prReviewBriefing, type PrReviewContext } from '@shared/prReview'
import { DEFAULT_PR_FILTERS } from '@shared/teamPrs'
import { isPrReviewSession, prReviewDir, prReviewGuard, prReviewPost, prReviewDirOk, prReviewFolderAccount, prReviewPane, PR_REVIEW_SETTINGS, writePrReviewContext, writePrReviewDir } from './prReviewDirs'

const URL = 'https://github.com/acme/web/pull/123'
const ctx = (o: Partial<PrReviewContext> = {}): PrReviewContext => ({
  tab: 'Mine',
  account: 'alice',
  filters: DEFAULT_PR_FILTERS,
  selected: { url: URL, repo: 'acme/web', number: 123 } as PrReviewContext['selected'],
  selectedAt: '2026-10-17T10:00:00.000Z',
  ...o,
})

describe('prReviewDir', () => {
  it('a folder per tab; a bad tab id is refused', () => {
    expect(prReviewDir('/h', 'prs-mine')).toBe(join('/h', 'pr-review', 'tab-prs-mine'))
    for (const bad of [null, undefined, '', '../x', 'a b', 'x'.repeat(65), 'a/b']) expect(() => prReviewDir('/h', bad)).toThrow(/tab/)
  })
  it('a folder not made yet is fine; a link out of pr-review is not', () => {
    const home = mkdtempSync(join(tmpdir(), 'prr-'))
    expect(prReviewDirOk(home, prReviewDir(home, 'a'))).toBe(true)
    mkdirSync(join(home, 'pr-review', 'tab-a'), { recursive: true })
    expect(prReviewDirOk(home, prReviewDir(home, 'a'))).toBe(true)
    const elsewhere = mkdtempSync(join(tmpdir(), 'prr-out-'))
    symlinkSync(elsewhere, join(home, 'pr-review', 'tab-b'))
    expect(prReviewDirOk(home, prReviewDir(home, 'b'))).toBe(false)
    expect(prReviewPane(home, false, { tab: 'b' }, () => ({ ok: true, args: [] }))).toEqual({ error: 'refusing a PR review folder that is a link' })
  })
})

describe('prReviewPane', () => {
  const ok = (l?: string) => ({ ok: true as const, args: ['--settings', `/acc/${l}.settings.json`] })
  it('one account: its tab folder, no settings', () => {
    expect(prReviewPane('/h', false, { tab: 't1', account: 'bob-work' }, ok)).toEqual({ cwd: join('/h', 'pr-review', 'tab-t1'), settings: [] })
  })
  it("several: the tab's folder as the tab's account; no account, a refused one or none written yet is refused", () => {
    expect(prReviewPane('/h', true, { tab: 't1', account: 'bob-work' }, ok)).toEqual({ cwd: join('/h', 'pr-review', 'tab-t1'), settings: ['--settings', '/acc/bob-work.settings.json'] })
    expect(prReviewPane('/h', true, { tab: 't1' }, ok)).toEqual({ error: 'refusing a PR review without its tab account' })
    expect(prReviewPane('/h', true, { tab: 't1', account: 'x' }, () => ({ ok: false, message: 'x must log in again' }))).toEqual({ error: 'x must log in again' })
    expect(prReviewPane('/h', true, { tab: 't1', account: 'x' }, () => ({ ok: true, args: [] }))).toMatchObject({ error: /still loading/ })
    expect(prReviewPane('/h', true, { account: 'x' }, ok)).toMatchObject({ error: /tab/ })
  })
})

describe('isPrReviewSession', () => {
  it('by name or by folder', () => {
    expect(isPrReviewSession({ name: 'md-pr-review-prs-mine' }, '/h')).toBe(true)
    expect(isPrReviewSession({ name: 'x', cwd: join('/h', 'pr-review', 'tab-a') }, '/h')).toBe(true)
    expect(isPrReviewSession({ name: 'x', cwd: join('/h', 'pr-review') }, '/h')).toBe(false)
    expect(isPrReviewSession({ name: 'md-pr-reviewer', cwd: '/w/repo' }, '/h')).toBe(false)
  })
})

describe('writePrReviewDir', () => {
  it('briefing, context, settings and an executable script; a context write leaves the rest', () => {
    const home = mkdtempSync(join(tmpdir(), 'prr-'))
    const dir = prReviewDir(home, 'a')
    const post = prReviewPost(home, 'a')
    // A copy from before (in the folder, where the session can rewrite it) is removed.
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'post-review.sh'), 'old')
    writePrReviewDir(dir, ctx(), prReviewBriefing('alice', post), prReviewGuard(home, 'a'), post)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain(post)
    expect(existsSync(join(dir, 'post-review.sh'))).toBe(false)
    expect(post.startsWith(dir)).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')).selected.url).toBe(URL)
    const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'))
    expect(s).toEqual(PR_REVIEW_SETTINGS)
    // The script is never allowed unasked; gh's own writes are denied.
    expect(JSON.stringify(s.permissions.allow)).not.toContain('post-review')
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash(gh pr review:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr merge:*)']))
    expect(statSync(post).mode & 0o111).not.toBe(0)
    expect(prReviewFolderAccount(home, 'a')).toBe('alice')
    // The account comes from the guard: the session editing context.json changes nothing.
    writeFileSync(join(dir, 'context.json'), JSON.stringify({ account: 'mallory' }))
    expect(prReviewFolderAccount(home, 'a')).toBe('alice')
    writeFileSync(join(dir, 'CLAUDE.md'), 'kept')
    writePrReviewContext(dir, ctx({ selected: null }), prReviewGuard(home, 'a'))
    expect(JSON.parse(readFileSync(prReviewGuard(home, 'a'), 'utf8'))).toEqual({ url: null, account: 'alice' })
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('kept')
    expect(JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')).selected).toBeNull()
    expect(existsSync(join(dir, 'context.json.tmp'))).toBe(false)
  })
  it('refuses a .claude that is a link', () => {
    const home = mkdtempSync(join(tmpdir(), 'prr-'))
    const dir = prReviewDir(home, 'a')
    mkdirSync(dir, { recursive: true })
    symlinkSync(mkdtempSync(join(tmpdir(), 'prr-c-')), join(dir, '.claude'))
    expect(() => writePrReviewDir(dir, ctx(), 'x', prReviewGuard(home, 'a'), prReviewPost(home, 'a'))).toThrow(/link/)
  })
})

describe('post-review.sh', { timeout: 20_000 }, () => {
  // A stand-in gh: `api user` answers $FAKE_LOGIN; a POST records its path and payload.
  const world = (c: PrReviewContext = ctx()) => {
    const home = mkdtempSync(join(tmpdir(), 'prr-'))
    const dir = prReviewDir(home, 'a')
    writePrReviewDir(dir, c, prReviewBriefing('alice', prReviewPost(home, 'a')), prReviewGuard(home, 'a'), prReviewPost(home, 'a'))
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash
if [ "$1 $2" = "api user" ]; then echo "$FAKE_LOGIN"; exit 0; fi
if [ "$1 $2 $3" = "api -X POST" ]; then echo "$4" > "${home}/posted-path"; cp "$6" "${home}/posted.json"
  echo '{"html_url":"${URL}#pullrequestreview-1","state":"COMMENTED"}'; exit 0; fi
exit 9
`,
    )
    chmodSync(join(bin, 'gh'), 0o755)
    writeFileSync(join(dir, 'review.md'), 'Looks good, one thing.\n')
    writeFileSync(join(dir, 'review.json'), JSON.stringify([{ path: 'src/a.ts', line: 4, body: 'Off by one?' }]))
    const run = (args: string[], login = 'Alice') => {
      const r = spawnSync(prReviewPost(home, 'a'), args, { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOGIN: login } })
      return { code: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop() || '{}') }
    }
    return { home, dir, run }
  }
  const args = ['--pr', URL, '--event', 'comment', '--body-file', 'review.md']

  it('posts one review with its inline comments to the selected PR, as the account', () => {
    const w = world()
    const r = w.run([...args, '--comments-file', 'review.json'])
    expect(r).toEqual({ code: 0, out: { ok: true, url: `${URL}#pullrequestreview-1`, state: 'COMMENTED' } })
    expect(readFileSync(join(w.home, 'posted-path'), 'utf8').trim()).toBe('repos/acme/web/pulls/123/reviews')
    expect(JSON.parse(readFileSync(join(w.home, 'posted.json'), 'utf8'))).toEqual({
      body: 'Looks good, one thing.\n',
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', line: 4, body: 'Off by one?' }],
    })
  })
  it('--dry-run prints the payload and posts nothing', () => {
    const w = world()
    const r = w.run(['--pr', URL, '--event', 'approve', '--body-file', 'review.md', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.out).toEqual({ ok: true, dryRun: true, pr: URL, review: { body: 'Looks good, one thing.\n', event: 'APPROVE' } })
    expect(existsSync(join(w.home, 'posted.json'))).toBe(false)
  })
  it('refuses another PR, no selection, the wrong account, files outside the folder, a bad event or comments', () => {
    const w = world()
    const refused = (a: string[], why: RegExp, login?: string) => {
      const r = w.run(a, login)
      expect(r.code).toBe(1)
      expect(r.out.ok).toBe(false)
      expect(r.out.error).toMatch(why)
    }
    refused(['--pr', 'https://github.com/acme/web/pull/9', '--event', 'comment', '--body-file', 'review.md'], /not the PR selected/)
    refused(args, /this session is mallory/, 'mallory')
    const outside = join(mkdtempSync(join(tmpdir(), 'prr-o-')), 'x.md')
    writeFileSync(outside, 'x')
    refused(['--pr', URL, '--event', 'comment', '--body-file', outside], /body file/)
    refused(['--pr', URL, '--event', 'comment', '--body-file', '../../../etc/hosts'], /body file/)
    symlinkSync(outside, join(w.dir, 'link.md'))
    refused(['--pr', URL, '--event', 'comment', '--body-file', 'link.md'], /body file/)
    refused(['--pr', URL, '--event', 'merge', '--body-file', 'review.md'], /usage/)
    // A trailing option ends in usage, never a loop that does not end.
    refused(['--dry-run', '--pr'], /usage/)
    refused([...args, '--comments-file'], /usage/)
    // The session's edits to context.json change nothing: the guard outside the folder decides.
    writeFileSync(join(w.dir, 'context.json'), JSON.stringify(ctx({ selected: { url: 'https://github.com/acme/web/pull/9' } as PrReviewContext['selected'], account: null })))
    refused(['--pr', 'https://github.com/acme/web/pull/9', '--event', 'comment', '--body-file', 'review.md'], /not the PR selected/)
    refused(args, /this session is mallory/, 'mallory')
    writeFileSync(join(w.dir, 'bad.json'), '{"path":"a"}')
    refused([...args, '--comments-file', 'bad.json'], /JSON array/)
    expect(existsSync(join(w.home, 'posted.json'))).toBe(false)
    const none = world(ctx({ selected: null }))
    const r = none.run(args)
    expect(r.out.error).toMatch(/no PR is selected/)
  })
  it('one account (none in the context): no account check', () => {
    const w = world(ctx({ account: null }))
    expect(w.run(args, 'whoever').out.ok).toBe(true)
  })
})
