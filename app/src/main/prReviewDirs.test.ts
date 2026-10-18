import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { prReviewBriefing, type PrReviewContext } from '@shared/prReview'
import { DEFAULT_PR_FILTERS } from '@shared/teamPrs'
import { parseLogLines } from '@shared/reviewBatch'
import { isPrReviewSession, prReviewBatchFile, prReviewBatchLog, prReviewDir, prReviewGuard, prReviewPost, prReviewDirOk, prReviewFolderAccount, prReviewPane, prReviewSettings, prReviewTurn, writePrReviewAuto, writePrReviewBatch, writePrReviewContext, writePrReviewContextBatch, writePrReviewDir, writePrReviewFiles } from './prReviewDirs'

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
    expect(s).toEqual(prReviewSettings(prReviewTurn(prReviewGuard(home, 'a')), post))
    // The script is never allowed unasked but for Automate Review's and Review selected's forms; gh's own writes are denied.
    expect(s.permissions.allow.filter((a: string) => a.includes('post-review'))).toEqual([`Bash(${post} --auto:*)`, `Bash(${post} --batch:*)`])
    // What runs unasked is outside the folder acceptEdits lets the session rewrite (cp, sed…), and no
    // script of that name is left in the folder for a `./post-review.sh` to find.
    expect(post.startsWith(`${dir}${sep}`)).toBe(false)
    expect(post.startsWith(join(home, 'pr-review-guard') + sep)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.includes('post-review'))).toEqual([])
    // Its hooks say when the turn is over, in the guard folder (outside the session's folder).
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`printf idle > '${prReviewTurn(prReviewGuard(home, 'a'))}'`)
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('printf busy')
    expect(s.hooks.PreToolUse[0].matcher).toBe('*')
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash(gh pr review:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr merge:*)']))
    // Windows has no execute bits.
    if (process.platform !== 'win32') expect(statSync(post).mode & 0o111).not.toBe(0)
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
  it('writePrReviewFiles leaves the context and the guard as they are', () => {
    const home = mkdtempSync(join(tmpdir(), 'prr-'))
    const dir = prReviewDir(home, 'a')
    writePrReviewDir(dir, ctx(), 'old', prReviewGuard(home, 'a'), prReviewPost(home, 'a'))
    writePrReviewFiles(dir, 'new', prReviewGuard(home, 'a'), prReviewPost(home, 'a'))
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('new')
    expect(JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')).selected.url).toBe(URL)
    expect(JSON.parse(readFileSync(prReviewGuard(home, 'a'), 'utf8')).url).toBe(URL)
  })
  it('refuses a .claude that is a link', () => {
    const home = mkdtempSync(join(tmpdir(), 'prr-'))
    const dir = prReviewDir(home, 'a')
    mkdirSync(dir, { recursive: true })
    symlinkSync(mkdtempSync(join(tmpdir(), 'prr-c-')), join(dir, '.claude'))
    expect(() => writePrReviewDir(dir, ctx(), 'x', prReviewGuard(home, 'a'), prReviewPost(home, 'a'))).toThrow(/link/)
  })
})

describe.skipIf(process.platform === 'win32')('post-review.sh', { timeout: 20_000 }, () => {
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
  it('--auto posts a comment to a PR Automate Review queued, and nothing else', () => {
    const w = world(ctx({ selected: null }))
    const other = 'https://github.com/acme/api/pull/7'
    const auto = ['--auto', '--pr', other, '--body-file', 'review.md']
    // Nothing queued yet: refused (whatever is selected).
    expect(w.run(auto).out.error).toMatch(/not a PR Automate Review queued/)
    writePrReviewAuto(prReviewGuard(w.home, 'a'), [other])
    const r = w.run([...auto, '--comments-file', 'review.json'])
    expect(r.out.ok).toBe(true)
    expect(readFileSync(join(w.home, 'posted-path'), 'utf8').trim()).toBe('repos/acme/api/pulls/7/reviews')
    expect(JSON.parse(readFileSync(join(w.home, 'posted.json'), 'utf8')).event).toBe('COMMENT')
    // Never another event, another PR, or as another account.
    expect(w.run([...auto, '--event', 'approve']).out.error).toMatch(/comment/)
    expect(w.run([...auto, '--event', 'request-changes']).out.error).toMatch(/comment/)
    expect(w.run(['--auto', '--pr', URL, '--body-file', 'review.md']).out.error).toMatch(/not a PR Automate Review queued/)
    expect(w.run(auto, 'mallory').out.error).toMatch(/this session is mallory/)
    // The plain form still wants the selected PR.
    expect(w.run(['--pr', other, '--event', 'comment', '--body-file', 'review.md']).out.error).toMatch(/no PR is selected/)
  })
  it('one account (none in the context): no account check', () => {
    const w = world(ctx({ account: null }))
    expect(w.run(args, 'whoever').out.ok).toBe(true)
  })

  describe('the batch (Review selected)', () => {
    const P1 = 'https://github.com/acme/api/pull/7'
    const P2 = 'https://github.com/acme/web/pull/8'
    const log = (home: string) => parseLogLines(existsSync(prReviewBatchLog(prReviewGuard(home, 'a'))) ? readFileSync(prReviewBatchLog(prReviewGuard(home, 'a')), 'utf8') : '')
    const batched = () => {
      const w = world()
      writePrReviewBatch(prReviewGuard(w.home, 'a'), [
        { url: P1, id: 'b1' },
        { url: P2, id: 'b2' },
      ])
      return w
    }
    it('--batch posts a comment to each PR of the batch, once, and logs it with its comment count', () => {
      const w = batched()
      const r = w.run(['--batch', '--pr', P1, '--body-file', 'review.md', '--comments-file', 'review.json'])
      expect(r.out).toEqual({ ok: true, url: `${URL}#pullrequestreview-1`, state: 'COMMENTED' })
      expect(readFileSync(join(w.home, 'posted-path'), 'utf8').trim()).toBe('repos/acme/api/pulls/7/reviews')
      expect(JSON.parse(readFileSync(join(w.home, 'posted.json'), 'utf8')).event).toBe('COMMENT')
      expect(log(w.home)).toEqual([{ id: 'b1', url: P1, status: 'posted', review: `${URL}#pullrequestreview-1`, comments: 1 }])
      // Still one review per PR per run: the same entry is not posted again.
      expect(w.run(['--batch', '--pr', P1, '--body-file', 'review.md']).out.error).toMatch(/already posted/)
      // The other PR of the batch, while P1 is still in the file.
      expect(w.run(['--batch', '--pr', P2, '--body-file', 'review.md']).out.ok).toBe(true)
      expect(log(w.home).map((l) => [l.id, l.status])).toEqual([
        ['b1', 'posted'],
        ['b2', 'posted'],
      ])
    })
    it('refuses a PR not in the batch, a cancelled one, another event, another account', () => {
      const w = batched()
      const other = 'https://github.com/acme/web/pull/99'
      expect(w.run(['--batch', '--pr', other, '--body-file', 'review.md']).out.error).toMatch(/not in the batch/)
      expect(w.run(['--batch', '--pr', P1, '--event', 'approve', '--body-file', 'review.md']).out.error).toMatch(/comment/)
      expect(w.run(['--batch', '--pr', P1, '--body-file', 'review.md'], 'mallory').out.error).toMatch(/this session is mallory/)
      // The account check failed after the PR was taken: logged as failed.
      expect(log(w.home)).toEqual([{ id: 'b1', url: P1, status: 'failed', note: "refusing: this session is mallory on GitHub, the tab's account is alice" }])
      // Cancelled: main dropped it from the file.
      writePrReviewBatch(prReviewGuard(w.home, 'a'), [{ url: P2, id: 'b2' }])
      expect(w.run(['--batch', '--pr', P1, '--body-file', 'review.md']).out.error).toMatch(/not in the batch/)
      expect(w.run(['--batch', '--start', '--pr', P1]).out.error).toMatch(/not in the batch/)
      // --auto and --batch together, or a mark without --batch: usage.
      expect(w.run(['--auto', '--batch', '--pr', P2, '--body-file', 'review.md']).out.error).toMatch(/usage/)
      expect(w.run(['--skip', 'x', '--pr', P2]).out.error).toMatch(/usage/)
      expect(existsSync(join(w.home, 'posted.json'))).toBe(false)
    })
    it('--start, --skip and --fail log a step and post nothing', () => {
      const w = batched()
      expect(w.run(['--batch', '--start', '--pr', P1]).out).toEqual({ ok: true, pr: P1, status: 'reviewing' })
      expect(w.run(['--batch', '--skip', 'no changes since the last review', '--pr', P1]).out.ok).toBe(true)
      expect(w.run(['--batch', '--fail', 'no access', '--pr', P2]).out.ok).toBe(true)
      expect(log(w.home)).toEqual([
        { id: 'b1', url: P1, status: 'reviewing' },
        { id: 'b1', url: P1, status: 'skipped', note: 'no changes since the last review' },
        { id: 'b2', url: P2, status: 'failed', note: 'no access' },
      ])
      expect(existsSync(join(w.home, 'posted.json'))).toBe(false)
    })
    it('GitHub refusing a batch post logs it as failed', () => {
      const w = batched()
      writeFileSync(join(w.home, 'bin', 'gh'), '#!/usr/bin/env bash\nif [ "$1 $2" = "api user" ]; then echo alice; exit 0; fi\necho "HTTP 422: Unprocessable" >&2; exit 1\n')
      expect(w.run(['--batch', '--pr', P1, '--body-file', 'review.md']).out.error).toMatch(/GitHub refused the review: HTTP 422/)
      expect(log(w.home)).toEqual([{ id: 'b1', url: P1, status: 'failed', note: 'GitHub refused the review: HTTP 422: Unprocessable' }])
    })
    it('the asked form takes the selected PR or a PR of the batch (any event), and logs a batch PR', () => {
      const w = batched()
      expect(w.run(['--pr', P2, '--event', 'approve', '--body-file', 'review.md']).out.ok).toBe(true)
      expect(JSON.parse(readFileSync(join(w.home, 'posted.json'), 'utf8')).event).toBe('APPROVE')
      expect(log(w.home).map((l) => [l.id, l.status])).toEqual([['b2', 'posted']])
      expect(w.run(['--pr', 'https://github.com/acme/web/pull/99', '--event', 'comment', '--body-file', 'review.md']).out.error).toMatch(/not the PR selected in MasterDeck .* nor in its batch/)
      // The selected PR (not in the batch) logs nothing.
      expect(w.run(args).out.ok).toBe(true)
      expect(log(w.home)).toHaveLength(1)
    })
  })
})

describe('writePrReviewContextBatch', () => {
  it("replaces context.json's batch only, never the guard; no context yet: nothing", () => {
    const home = mkdtempSync(join(tmpdir(), 'prr-'))
    const dir = prReviewDir(home, 'a')
    writePrReviewContextBatch(dir, [])
    expect(existsSync(join(dir, 'context.json'))).toBe(false)
    writePrReviewDir(dir, ctx(), 'x', prReviewGuard(home, 'a'), prReviewPost(home, 'a'))
    // The session wrote into its context: that never reaches the guard.
    writeFileSync(join(dir, 'context.json'), JSON.stringify({ ...ctx(), selected: { url: 'https://github.com/acme/web/pull/9' } }))
    const batch = [{ id: 'b1', status: 'queued', url: URL, repo: 'acme/web', number: 123 }]
    writePrReviewContextBatch(dir, batch)
    const c = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    expect(c.batch).toEqual(batch)
    expect(c.tab).toBe('Mine')
    expect(JSON.parse(readFileSync(prReviewGuard(home, 'a'), 'utf8')).url).toBe(URL)
    expect(existsSync(prReviewBatchFile(prReviewGuard(home, 'a')))).toBe(false)
  })
})
