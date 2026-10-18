import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify, isDocsOnly, isPackageFile, lockChanged, pkgChanged } from './ci-changes.mjs'

const SCRIPT = join(__dirname, 'ci-changes.mjs')

describe('isDocsOnly', () => {
  it('skips docs, notes and the other workflows', () => {
    for (const p of ['README.md', 'docs/OPERATIONS.md', 'docs/images/x.png', '.claude/settings.json', '.github/releases/v0.9.2.md',
      '.github/workflows/ota-main.yml', 'LICENSE', '.gitignore', 'app/README.md', ''])
      expect(isDocsOnly(p), p).toBe(true)
  })

  it('runs the tests for code, tests, shipped Markdown and CI itself', () => {
    for (const p of ['app/src/main/index.ts', 'app/src/shared/x.test.ts', 'skills/master/tests/test_x.py', 'skills/master/SKILL.md',
      'mods/masterdeck/commands/x.md', 'app/test/fixtures/a.md', 'install.sh', '.github/workflows/ci.yml',
      '.github/actions/setup-app/action.yml', '.github/requirements-ci.txt'])
      expect(isDocsOnly(p), p).toBe(false)
  })
})

describe('isPackageFile', () => {
  it('knows the build inputs', () => {
    for (const p of ['app/electron-builder.yml', 'app/scripts/whisper.sh', 'app/scripts/mute.sh', 'app/native/mute/main.swift',
      'app/build/icon.icns', '.github/workflows/build.yml', '.github/actions/native-helpers/action.yml'])
      expect(isPackageFile(p), p).toBe(true)
    for (const p of ['app/src/main/index.ts', 'app/package.json', '.github/workflows/ci.yml']) expect(isPackageFile(p), p).toBe(false)
  })
})

describe('package.json and its lock', () => {
  const pkg = (o: object) => JSON.stringify({ name: 'masterdeck', version: '0.9.1', scripts: { test: 'vitest run', postinstall: 'x' }, dependencies: { ws: '^8' }, ...o })

  it('ignores the version and the dev scripts', () => {
    expect(pkgChanged(pkg({}), pkg({ version: '0.10.0' }))).toBe(false)
    expect(pkgChanged(pkg({}), pkg({ scripts: { test: 'vitest', postinstall: 'x' } }))).toBe(false)
  })

  it('sees dependencies, postinstall and a new file', () => {
    expect(pkgChanged(pkg({}), pkg({ dependencies: { ws: '^9' } }))).toBe(true)
    expect(pkgChanged(pkg({}), pkg({ scripts: { postinstall: 'y' } }))).toBe(true)
    expect(pkgChanged(null, pkg({}))).toBe(true)
    expect(pkgChanged('{', pkg({}))).toBe(true)
  })

  it("ignores the lock's own version", () => {
    const lock = (v: string, ws = '8.0.0') => JSON.stringify({ version: v, packages: { '': { version: v }, 'node_modules/ws': { version: ws } } })
    expect(lockChanged(lock('0.9.1'), lock('0.10.0'))).toBe(false)
    expect(lockChanged(lock('0.9.1'), lock('0.9.1', '8.1.0'))).toBe(true)
  })
})

describe('classify', () => {
  it('runs nothing heavy for docs', () => {
    expect(classify(['README.md', 'docs/TODO.md'])).toEqual({ code: false, workflows: false, package: false })
  })

  it('lints workflows, and runs the tests when CI itself changed', () => {
    expect(classify(['.github/workflows/ota-main.yml'])).toEqual({ code: false, workflows: true, package: false })
    expect(classify(['.github/workflows/ci.yml'])).toEqual({ code: true, workflows: true, package: false })
  })

  it('builds for packaging files, a dependency or the build label', () => {
    expect(classify(['app/src/main/index.ts'])).toEqual({ code: true, workflows: false, package: false })
    expect(classify(['app/scripts/whisper.sh']).package).toBe(true)
    expect(classify(['docs/x.md'], { labels: ['build'] }).package).toBe(true)
    const before = JSON.stringify({ version: '1.0.0', dependencies: { a: '1' } })
    expect(classify(['app/package.json'], { pkgBefore: before, pkgAfter: JSON.stringify({ version: '1.0.1', dependencies: { a: '1' } }) }).package).toBe(false)
    expect(classify(['app/package.json'], { pkgBefore: before, pkgAfter: JSON.stringify({ version: '1.0.0', dependencies: { a: '2' } }) }).package).toBe(true)
  })
})

describe('the CLI', () => {
  it('reads a range of a real repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-changes-'))
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'ci@acme.test')
      git('config', 'user.name', 'acme')
      mkdirSync(join(dir, 'app'))
      writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify({ version: '1.0.0', dependencies: { a: '1' } }))
      git('add', '.')
      git('commit', '-qm', 'one')
      const base = git('rev-parse', 'HEAD')
      writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify({ version: '1.0.1', dependencies: { a: '1' } }))
      writeFileSync(join(dir, 'README.md'), 'hi\n')
      git('add', '.')
      git('commit', '-qm', 'two')
      const out = execFileSync('node', [SCRIPT, '--base', base, '--head', 'HEAD', '--labels', 'docs'], { cwd: dir, encoding: 'utf8' })
      expect(out).toBe('code=yes\nworkflows=no\npackage=no\n')
      const built = execFileSync('node', [SCRIPT, '--base', base, '--head', 'HEAD', '--labels', 'docs, build'], { cwd: dir, encoding: 'utf8' })
      expect(built).toContain('package=yes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
