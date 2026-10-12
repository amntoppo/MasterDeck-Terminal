import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FILE_MAX_BYTES } from '../shared/fileView'
import { makeRunner } from './run'
import { SessionFiles, UNTRACKED_MAX } from './sessionFiles'

const run = makeRunner(() => ({ ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }))
const files = new SessionFiles(run)
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' }).toString()

let top: string
let repo: string
let plain: string

beforeAll(() => {
  top = realpathSync.native(mkdtempSync(join(tmpdir(), 'md-sf-')))
  repo = join(top, 'repo')
  plain = join(top, 'plain')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/a.ts'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'gone.txt'), 'bye\n')
  writeFileSync(join(repo, 'old.md'), '# Title\n\nsome text that stays the same\nand more\n')
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'one')
  git(repo, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(repo, 'committed.ts'), 'x\ny\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'two')
  // Uncommitted: a change, a delete, a rename, an untracked file, an ignored one, a binary change.
  writeFileSync(join(repo, 'src/a.ts'), 'one\nTWO\nthree\nfour\n')
  rmSync(join(repo, 'gone.txt'))
  git(repo, 'mv', 'old.md', 'new.md')
  writeFileSync(join(repo, 'scratch.txt'), 'a\nb\nc\n')
  writeFileSync(join(repo, 'ignored.log'), 'x')
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 9, 9, 9]))
  writeFileSync(join(repo, 'big.txt'), 'x'.repeat(FILE_MAX_BYTES + 10))
  // A Next.js-style name: git reads pathspecs as globs unless told not to.
  mkdirSync(join(repo, 'app/[id]'), { recursive: true })
  mkdirSync(join(repo, 'app/i'), { recursive: true })
  writeFileSync(join(repo, 'app/[id]/page.tsx'), 'id\n')
  writeFileSync(join(repo, 'app/i/page.tsx'), 'i\n')
  git(repo, 'add', 'app')
  git(repo, 'commit', '-q', '-m', 'pages', '--', 'app')
  writeFileSync(join(repo, 'app/[id]/page.tsx'), 'id changed\n')
  writeFileSync(join(repo, 'app/i/page.tsx'), 'i changed\n')
  writeFileSync(join(repo, 'empty.txt'), '')
  writeFileSync(join(top, 'secret.txt'), 'outside')
  symlinkSync(join(top, 'secret.txt'), join(repo, 'out-link.txt'))
  symlinkSync(join(top, 'secret.txt'), join(repo, 'link.txt'))

  mkdirSync(join(plain, 'docs'), { recursive: true })
  mkdirSync(join(plain, 'node_modules/x'), { recursive: true })
  mkdirSync(join(plain, '.hidden'), { recursive: true })
  writeFileSync(join(plain, 'docs/readme.md'), 'hi')
  writeFileSync(join(plain, 'node_modules/x/i.js'), '')
  writeFileSync(join(plain, '.hidden/h.txt'), '')
  writeFileSync(join(plain, 'top.txt'), '')
})
afterAll(() => rmSync(top, { recursive: true, force: true }))

describe('list', () => {
  it('lists tracked and untracked files of a repository, not ignored ones', async () => {
    const r = await files.list(repo)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.paths).toContain('src/a.ts')
    expect(r.paths).toContain('scratch.txt')
    expect(r.paths).toContain('new.md')
    expect(r.paths).not.toContain('ignored.log')
    expect(r.paths).not.toContain('gone.txt')
    expect(r.truncated).toBe(false)
  })
  it('walks a folder that is not a repository, skipping node_modules and dot-folders', async () => {
    const r = await files.list(plain)
    expect(r).toEqual({ ok: true, paths: ['docs/readme.md', 'top.txt'], truncated: false })
  })
  it('refuses a folder that is not there', async () => {
    expect((await files.list(join(top, 'nope'))).ok).toBe(false)
  })
})

describe('read', () => {
  it('reads a text file', async () => {
    const r = await files.read(repo, 'src/a.ts')
    expect(r).toMatchObject({ ok: true, path: 'src/a.ts', text: 'one\nTWO\nthree\nfour\n', refused: null })
  })
  it('says why a file is not shown', async () => {
    expect(await files.read(repo, 'logo.bin')).toMatchObject({ ok: true, text: null, refused: 'binary' })
    expect(await files.read(repo, 'big.txt')).toMatchObject({ ok: true, text: null, refused: 'too-large' })
    expect(await files.read(repo, 'gone.txt')).toMatchObject({ ok: true, text: null, refused: 'missing' })
    expect(await files.read(repo, 'src')).toMatchObject({ ok: true, text: null, refused: 'not-file' })
  })
  it('never reads git internals or ssh keys by name', async () => {
    expect(await files.read(repo, '.git/config')).toMatchObject({ ok: true, text: null, refused: 'outside' })
    expect(await files.read(repo, 'a/.ssh/id_rsa')).toMatchObject({ ok: true, text: null, refused: 'outside' })
  })
  it('never walks a home folder', async () => {
    expect(await new SessionFiles(run, plain).list(plain)).toEqual({ ok: false, message: 'This session works in your home folder: open a session in a project to see its files.' })
  })
  it('never follows a path or a link out of the folder', async () => {
    expect(await files.read(repo, 'link.txt')).toMatchObject({ ok: true, text: null, refused: 'outside' })
    expect(await files.read(repo, '../secret.txt')).toMatchObject({ ok: false })
  })
})

describe('changes', () => {
  it('lists uncommitted changes against HEAD, untracked as added', async () => {
    const r = await files.changes(repo, 'uncommitted')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]))
    expect(by['src/a.ts']).toMatchObject({ status: 'modified', add: 2, del: 1 })
    expect(by['gone.txt']).toMatchObject({ status: 'deleted', del: 1 })
    expect(by['new.md']).toMatchObject({ status: 'renamed', oldPath: 'old.md' })
    expect(by['scratch.txt']).toMatchObject({ status: 'added', add: 3, untracked: true })
    expect(by['logo.bin']).toMatchObject({ status: 'modified', binary: true })
    expect(by['committed.ts']).toBeUndefined()
    expect(by['ignored.log']).toBeUndefined()
  })
  it('counts at most UNTRACKED_MAX untracked files, and says how many more there are', async () => {
    const many = join(top, 'many')
    mkdirSync(many)
    git(many, 'init', '-q', '-b', 'main')
    for (let i = 0; i < UNTRACKED_MAX + 5; i++) writeFileSync(join(many, `f${String(i).padStart(4, '0')}.txt`), 'x\n')
    const r = await files.changes(many, 'uncommitted')
    expect(r.ok && r.files.length).toBe(UNTRACKED_MAX)
    expect(r.ok && r.more).toBe(5)
    expect(r.ok && r.files.every((f) => f.add === 1)).toBe(true)
  })
  it('includes commits since the default branch for the branch base', async () => {
    const r = await files.changes(repo, 'branch')
    expect(r.ok && r.files.find((f) => f.path === 'committed.ts')).toMatchObject({ status: 'added', add: 2 })
    expect(r.ok && r.files.some((f) => f.path === 'src/a.ts')).toBe(true)
  })
  it('says when there is no default branch or no repository', async () => {
    const lone = join(top, 'lone')
    mkdirSync(lone)
    git(lone, 'init', '-q', '-b', 'work')
    writeFileSync(join(lone, 'f'), 'x\n')
    expect(await files.changes(lone, 'branch')).toEqual({ ok: false, message: 'No default branch found' })
    // A repository with no commit yet: everything is untracked.
    const r = await files.changes(lone, 'uncommitted')
    expect(r.ok && r.files.map((f) => f.path)).toEqual(['f'])
    expect(await files.changes(plain, 'uncommitted')).toEqual({ ok: false, message: 'Not a git repository' })
  })
})

describe('fileDiff', () => {
  it('diffs a modified file', async () => {
    const r = await files.fileDiff(repo, 'src/a.ts', 'uncommitted')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const lines = r.diff.hunks.flatMap((h) => h.lines.map((l) => `${l.kind}:${l.text}`))
    expect(lines).toEqual(['ctx:one', 'del:two', 'add:TWO', 'ctx:three', 'add:four'])
  })
  it('shows an untracked file as all added, and a deleted one as all removed', async () => {
    const u = await files.fileDiff(repo, 'scratch.txt', 'uncommitted')
    expect(u.ok && u.diff.hunks[0].lines.map((l) => l.kind)).toEqual(['add', 'add', 'add'])
    const d = await files.fileDiff(repo, 'gone.txt', 'uncommitted')
    expect(d.ok && d.diff.hunks[0].lines).toEqual([{ kind: 'del', text: 'bye', old: 1 }])
  })
  it('follows a rename and says when a file is binary', async () => {
    const r = await files.fileDiff(repo, 'new.md', 'uncommitted')
    expect(r.ok && r.diff.hunks).toEqual([])
    const b = await files.fileDiff(repo, 'logo.bin', 'uncommitted')
    expect(b.ok && b.diff.binary).toBe(true)
  })
  it('takes a path literally, never as a glob', async () => {
    const r = await files.fileDiff(repo, 'app/[id]/page.tsx', 'uncommitted')
    expect(r.ok && r.diff.hunks.flatMap((h) => h.lines.map((l) => l.text))).toEqual(['id', 'id changed'])
  })
  it('says an untracked link out of the folder is outside, and an empty new file has no lines', async () => {
    expect(await files.fileDiff(repo, 'out-link.txt', 'uncommitted')).toEqual({ ok: false, message: "This path is outside the session's folder." })
    const e = await files.fileDiff(repo, 'empty.txt', 'uncommitted')
    expect(e.ok && e.diff.hunks).toEqual([])
  })
  it('diffs against the merge base for the branch base', async () => {
    const r = await files.fileDiff(repo, 'committed.ts', 'branch')
    expect(r.ok && r.diff.hunks[0].lines.map((l) => l.kind)).toEqual(['add', 'add'])
  })
})
