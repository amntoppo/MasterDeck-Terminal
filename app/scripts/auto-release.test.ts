import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IGNORED_PATHS, appChanged, compareVersions, isAppFile, nextVersion, parseVersion, releaseNotes, releaseTags } from './auto-release.mjs'

const SCRIPT = join(__dirname, 'auto-release.mjs')

describe('versions', () => {
  it('parses tags and versions', () => {
    expect(parseVersion('v0.9.1')).toEqual({ major: 0, minor: 9, patch: 1, pre: '' })
    expect(parseVersion('0.10.0-beta.2')).toEqual({ major: 0, minor: 10, patch: 0, pre: 'beta.2' })
    expect(parseVersion('v1.2')).toBeNull()
    expect(parseVersion('release-1')).toBeNull()
  })

  it('orders as semver', () => {
    const sorted = ['0.10.0', '0.9.10', '0.9.2', '0.10.0-beta.2', '0.10.0-beta.10', '0.10.0-beta.1', '1.0.0']
      .sort(compareVersions)
    expect(sorted).toEqual(['0.9.2', '0.9.10', '0.10.0-beta.1', '0.10.0-beta.2', '0.10.0-beta.10', '0.10.0', '1.0.0'])
  })

  it('keeps only release tags, highest first', () => {
    expect(releaseTags(['v0.8.2', 'v0.9.0', 'nightly', 'v0.9.1-beta.1', '0.9.5'])).toEqual(['v0.9.1-beta.1', 'v0.9.0', 'v0.8.2'])
  })
})

describe('nextVersion', () => {
  const tags = ['v0.7.1', 'v0.8.0', 'v0.8.2', 'v0.9.0']

  it('adds one to the latest stable tag', () => {
    expect(nextVersion({ tags, pkgVersion: '0.9.0' })).toBe('0.9.1')
    expect(nextVersion({ tags: [...tags, 'v0.9.1'], pkgVersion: '0.9.0' })).toBe('0.9.2')
  })

  it('compares numerically, not as text', () => {
    expect(nextVersion({ tags: ['v0.9.9', 'v0.9.10'], pkgVersion: '0.9.0' })).toBe('0.9.11')
  })

  it("takes package.json's version when a minor or major was bumped by hand", () => {
    expect(nextVersion({ tags, pkgVersion: '0.10.0' })).toBe('0.10.0')
    expect(nextVersion({ tags, pkgVersion: '1.0.0' })).toBe('1.0.0')
    // Once that is tagged, patches go on from it.
    expect(nextVersion({ tags: [...tags, 'v0.10.0'], pkgVersion: '0.10.0' })).toBe('0.10.1')
  })

  it("drops package.json's prerelease suffix", () => {
    expect(nextVersion({ tags, pkgVersion: '0.10.0-beta.1' })).toBe('0.10.0')
  })

  it('ignores beta tags for the stable version', () => {
    expect(nextVersion({ tags: [...tags, 'v0.9.1-beta.3'], pkgVersion: '0.9.0' })).toBe('0.9.1')
  })

  it('numbers betas of the next version', () => {
    expect(nextVersion({ tags, pkgVersion: '0.9.0', channel: 'beta' })).toBe('0.9.1-beta.1')
    expect(nextVersion({ tags: [...tags, 'v0.9.1-beta.1', 'v0.9.1-beta.2'], pkgVersion: '0.9.0', channel: 'beta' })).toBe('0.9.1-beta.3')
    // A manual beta tag of another version does not count.
    expect(nextVersion({ tags: [...tags, 'v0.10.0-beta.4'], pkgVersion: '0.9.0', channel: 'beta' })).toBe('0.9.1-beta.1')
    expect(nextVersion({ tags, pkgVersion: '0.10.0', channel: 'beta' })).toBe('0.10.0-beta.1')
  })

  it('starts from package.json with no tags at all', () => {
    expect(nextVersion({ tags: [], pkgVersion: '0.1.0' })).toBe('0.1.0')
  })

  it('refuses a bad version or channel', () => {
    expect(() => nextVersion({ tags, pkgVersion: 'x' })).toThrow(/not a version/)
    // @ts-expect-error a wrong channel on purpose
    expect(() => nextVersion({ tags, pkgVersion: '0.9.0', channel: 'nightly' })).toThrow(/stable or beta/)
  })
})

describe('appChanged', () => {
  it('skips docs, tests, CI and tooling', () => {
    for (const f of ['README.md', 'docs/OPERATIONS.md', 'docs/images/hero.png', '.github/workflows/ci.yml', '.github/release-notes.md',
      'app/src/shared/derive.test.ts', 'app/src/renderer/src/components/X.test.tsx', 'skills/master/tests/test_cli.py',
      'app/web/wrangler.jsonc', 'install.sh', 'LICENSE', '.gitignore', 'mods/masterdeck/README.md', 'CLAUDE.md'])
      expect(isAppFile(f), f).toBe(false)
  })

  it('releases app code, skills, mods and package files', () => {
    for (const f of ['app/src/main/index.ts', 'app/package.json', 'app/package-lock.json', 'skills/master/lib/master/cli.py',
      'mods/masterdeck/hooks/core.ts', 'app/electron-builder.yml', 'app/build/icon.icns'])
      expect(isAppFile(f), f).toBe(true)
  })

  it("matches ota-main.yml's paths-ignore", () => {
    const yml = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'ota-main.yml'), 'utf8')
      .replace(/\r\n/g, '\n') // a Windows checkout has CRLF
    const block = /paths-ignore:\n((?:\s+- .+\n)+)/.exec(yml)?.[1] ?? ''
    const globs = block.split('\n').map((l) => l.trim().replace(/^- '(.*)'$/, '$1')).filter(Boolean)
    expect(globs).toEqual(IGNORED_PATHS)
    // One sample per glob is not an app file.
    const sample = (g: string) => g.replace('**/', 'app/src/x/').replace('/**', '/a/b.ts').replace('*', 'name')
    for (const g of IGNORED_PATHS) expect(isAppFile(sample(g)), g).toBe(false)
  })

  it('needs one app file in the range', () => {
    expect(appChanged(['docs/TODO.md', 'README.md', ''])).toBe(false)
    expect(appChanged(['docs/TODO.md', 'app/src/main/send.ts'])).toBe(true)
    expect(appChanged([])).toBe(false)
  })
})

describe('releaseNotes', () => {
  it('lists each merged PR once, with its tickets, and direct pushes by subject', () => {
    const notes = releaseNotes({
      version: '0.9.1',
      entries: [
        { sha: 'a'.repeat(40), subject: 'Merge pull request #170', pr: { number: 170, title: 'Fix the  PR watch\non resume', url: 'https://github.com/acme/x/pull/170', issues: [{ number: 158, url: 'https://github.com/acme/x/issues/158' }] } },
        { sha: 'b'.repeat(40), subject: 'Merge pull request #171', pr: { number: 171, title: 'Faster board', url: 'https://github.com/acme/x/pull/171' } },
        { sha: 'c'.repeat(40), subject: 'Merge again', pr: { number: 171, title: 'Faster board', url: 'https://github.com/acme/x/pull/171' } },
        { sha: 'd1e2f3a4b5', subject: 'Typo in the Start dialog' },
      ],
    })
    expect(notes).toBe(
      "## What's new in 0.9.1\n\n" +
        '- Fix the PR watch on resume ([#170](https://github.com/acme/x/pull/170), for [#158](https://github.com/acme/x/issues/158))\n' +
        '- Faster board ([#171](https://github.com/acme/x/pull/171))\n' +
        '- Typo in the Start dialog (d1e2f3a)\n',
    )
  })

  it('never comes out empty', () => {
    expect(releaseNotes({ version: '0.9.2', entries: [] })).toContain('- Small fixes.')
  })
})

describe('CLI', () => {
  const run = (args: string[], input = '') => execFileSync('node', [SCRIPT, ...args], { input, encoding: 'utf8' })

  it('next reads the tags from stdin', () => {
    expect(run(['next', '--pkg', '0.9.0'], 'v0.8.2\nv0.9.0\n').trim()).toBe('0.9.1')
    expect(run(['next', '--pkg', '0.9.0', '--channel', 'beta'], 'v0.9.0\n').trim()).toBe('0.9.1-beta.1')
  })

  it('latest prints the highest release tag, or nothing', () => {
    expect(run(['latest'], 'v0.9.0\nv0.10.0-beta.1\nv0.9.10\nnightly\n').trim()).toBe('v0.10.0-beta.1')
    expect(run(['latest'], '').trim()).toBe('')
  })

  it('changed reads the files from stdin', () => {
    expect(run(['changed'], 'docs/a.md\n').trim()).toBe('no')
    expect(run(['changed'], 'docs/a.md\napp/src/main/index.ts\n').trim()).toBe('yes')
  })

  it('notes reads the entries from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-auto-release-'))
    try {
      const f = join(dir, 'entries.json')
      writeFileSync(f, JSON.stringify([{ sha: 'abcdef1234', subject: 'One fix' }]))
      expect(run(['notes', '--version', '0.9.1', '--entries', f])).toBe("## What's new in 0.9.1\n\n- One fix (abcdef1)\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails on a bad call', () => {
    expect(() => execFileSync('node', [SCRIPT, 'next'], { stdio: 'pipe' })).toThrow()
    expect(() => execFileSync('node', [SCRIPT, 'bogus'], { stdio: 'pipe' })).toThrow()
  })
})
