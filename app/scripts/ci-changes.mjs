#!/usr/bin/env node
// What a pull request's checks must run (MasterDeck-Terminal#178, .github/workflows/ci.yml and
// package.yml), from the files it changes: the tests (`code`), actionlint (`workflows`) and the
// mac/win builds (`package`). Pure functions plus a small CLI; git stays out of the functions.
// Node 22, no dependencies.
//
//   node scripts/ci-changes.mjs --base <sha> --head <sha> [--labels build,docs]
//
// prints `code=yes|no`, `workflows=yes|no`, `package=yes|no` (one per line, for $GITHUB_OUTPUT).
// Not ota-main.yml's list (auto-release.mjs isAppFile): that one skips tests, which a PR must run.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The files of CI itself that the checks depend on: a change to them runs everything.
const CI_FILES = ['.github/workflows/ci.yml', '.github/requirements-ci.txt']
const CI_DIRS = ['.github/actions/']

/**
 * True when `path` changes nothing the tests read: Markdown outside the shipped skills, mods and
 * app source, `docs/`, `.claude/`, `.github/` (but CI's own files), `LICENSE`, `.gitignore`.
 * ponytail: a fixed list; a new docs-only folder runs the tests until it is added here.
 */
export function isDocsOnly(path) {
  const p = path.trim().replace(/^\.\//, '')
  if (!p) return true
  if (CI_FILES.includes(p) || CI_DIRS.some((d) => p.startsWith(d))) return false
  if (['docs/', '.claude/', '.github/'].some((d) => p.startsWith(d))) return true
  if (['LICENSE', '.gitignore'].includes(p)) return true
  // SKILL.md, a mod's commands and Markdown fixtures ship or are read by tests.
  return p.endsWith('.md') && !['skills/', 'mods/', 'app/src/', 'app/test/'].some((d) => p.startsWith(d))
}

/** The files the installers are built from, beyond the code the tests cover. */
const PACKAGE_FILES = [
  'app/electron-builder.yml',
  'app/electron.vite.config.ts',
  'app/scripts/whisper.sh',
  'app/scripts/mute.sh',
  '.github/workflows/build.yml',
  '.github/workflows/package.yml',
]
const PACKAGE_DIRS = ['app/build/', 'app/native/', 'app/resources/', '.github/actions/']

export function isPackageFile(path) {
  const p = path.trim().replace(/^\.\//, '')
  return PACKAGE_FILES.includes(p) || PACKAGE_DIRS.some((d) => p.startsWith(d))
}

// The parts of app/package.json a build depends on (not its version, nor the dev scripts).
const PKG_KEYS = ['main', 'dependencies', 'devDependencies', 'optionalDependencies', 'build']
const PKG_SCRIPTS = ['postinstall', 'build', 'dist:mac', 'dist:win']

/** True when app/package.json changed in a way the installers see. Unparsable: assume it did. */
export function pkgChanged(before, after) {
  const pick = (text) => {
    if (text == null) return null
    const j = JSON.parse(text)
    const o = {}
    for (const k of PKG_KEYS) o[k] = j[k] ?? null
    for (const s of PKG_SCRIPTS) o[`scripts.${s}`] = j.scripts?.[s] ?? null
    return JSON.stringify(o)
  }
  try {
    return pick(before) !== pick(after)
  } catch {
    return true
  }
}

/** True when the lock changed beyond its own version (a version bump rewrites it). */
export function lockChanged(before, after) {
  const pick = (text) => {
    if (text == null) return null
    const j = JSON.parse(text)
    const packages = { ...(j.packages ?? {}) }
    if (packages['']) packages[''] = { ...packages[''], version: null }
    return JSON.stringify(packages)
  }
  try {
    return pick(before) !== pick(after)
  } catch {
    return true
  }
}

/**
 * @param {string[]} files the changed paths
 * @param {{pkgBefore?: string|null, pkgAfter?: string|null, lockBefore?: string|null,
 *   lockAfter?: string|null, labels?: string[]}} [o] app/package.json and its lock on both sides
 *   (null: not there), the PR's labels
 */
export function classify(files, o = {}) {
  const list = files.map((f) => f.trim()).filter(Boolean)
  const has = (p) => list.includes(p)
  return {
    code: list.some((f) => !isDocsOnly(f)),
    workflows: list.some((f) => /^\.github\/(workflows|actions)\/.+\.ya?ml$/.test(f)),
    package:
      (o.labels ?? []).includes('build') ||
      list.some(isPackageFile) ||
      (has('app/package.json') && pkgChanged(o.pkgBefore ?? null, o.pkgAfter ?? null)) ||
      (has('app/package-lock.json') && lockChanged(o.lockBefore ?? null, o.lockAfter ?? null)),
  }
}

function args(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unknown argument ${argv[i]}`)
    const v = argv[i + 1]
    if (v == null || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`)
    o[argv[i].slice(2)] = v
    i++
  }
  return o
}

function main() {
  const o = args(process.argv.slice(2))
  if (!o.base || !o.head) throw new Error('usage: ci-changes.mjs --base <sha> --head <sha> [--labels a,b]')
  const git = (a, quiet = false) =>
    execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'] })
  // A file the commit does not have is null.
  const show = (rev, path) => {
    try {
      return git(['show', `${rev}:${path}`], true)
    } catch {
      return null
    }
  }
  // From where the PR left the base: what it changed, not what the base did meanwhile.
  const from = git(['merge-base', o.base, o.head]).trim()
  const files = git(['diff', '--name-only', from, o.head]).split('\n')
  const r = classify(files, {
    pkgBefore: show(from, 'app/package.json'),
    pkgAfter: show(o.head, 'app/package.json'),
    lockBefore: show(from, 'app/package-lock.json'),
    lockAfter: show(o.head, 'app/package-lock.json'),
    labels: (o.labels ?? '').split(',').map((l) => l.trim()).filter(Boolean),
  })
  for (const [k, v] of Object.entries(r)) console.log(`${k}=${v ? 'yes' : 'no'}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (e) {
    console.error(`ci-changes: ${e.message}`)
    process.exit(1)
  }
}
