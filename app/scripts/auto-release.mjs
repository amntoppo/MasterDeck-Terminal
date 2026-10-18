#!/usr/bin/env node
// The decisions of the automatic release on every merge to main (MasterDeck-Terminal#166,
// .github/workflows/ota-main.yml): the next version, whether a range of changed files is worth a
// release, and the update's notes from the merged PRs. Pure functions plus a small CLI the
// workflow calls; git and gh stay in the workflow. Node 22, no dependencies.
//
//   git tag -l 'v*' | node scripts/auto-release.mjs next --pkg 0.9.0 [--channel stable|beta]
//   git tag -l 'v*' | node scripts/auto-release.mjs latest              # the highest release tag
//   git diff --name-only A B | node scripts/auto-release.mjs changed     # prints yes or no
//   node scripts/auto-release.mjs notes --version 0.9.1 --entries entries.json
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** {major, minor, patch, pre} of `0.9.1`, `v0.9.1` or `0.10.0-beta.2`, else null. */
export function parseVersion(s) {
  const m = VERSION.exec(String(s).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' }
}

/** Semver order: the numbers, then a prerelease before its release, prereleases by identifier. */
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a
  const y = typeof b === 'string' ? parseVersion(b) : b
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  const p = x.pre.split('.')
  const q = y.pre.split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    const pn = /^\d+$/.test(p[i])
    const qn = /^\d+$/.test(q[i])
    if (pn && qn && Number(p[i]) !== Number(q[i])) return Number(p[i]) < Number(q[i]) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1
  }
  return 0
}

const core = (v) => `${v.major}.${v.minor}.${v.patch}`

/** The release tags (`vX.Y.Z`, `vX.Y.Z-pre`) of a tag list, highest first. */
export function releaseTags(tags) {
  return tags
    .map((t) => t.trim())
    .filter((t) => t.startsWith('v') && parseVersion(t))
    .sort((a, b) => compareVersions(b, a))
}

/**
 * The version a merge to main releases: the highest stable tag plus one patch, or package.json's
 * version (its `-suffix` dropped) when that is higher: a minor or major bump is made by hand there.
 * On the beta channel that version gets `-beta.N`, N one above the highest beta of it so far.
 * @param {{tags: string[], pkgVersion: string, channel?: 'stable' | 'beta'}} o
 */
export function nextVersion({ tags, pkgVersion, channel = 'stable' }) {
  const pkg = parseVersion(pkgVersion)
  if (!pkg) throw new Error(`app/package.json's version is not a version: ${pkgVersion}`)
  const all = releaseTags(tags).map(parseVersion)
  const stable = all.find((v) => !v.pre)
  let next = stable ? { ...stable, patch: stable.patch + 1, pre: '' } : { ...pkg, pre: '' }
  const pkgCore = { ...pkg, pre: '' }
  if (compareVersions(pkgCore, next) > 0) next = pkgCore
  if (channel === 'stable') return core(next)
  if (channel !== 'beta') throw new Error(`channel must be stable or beta, not ${channel}`)
  let n = 0
  for (const v of all) {
    const m = /^beta\.(\d+)$/.exec(v.pre)
    if (m && core(v) === core(next)) n = Math.max(n, Number(m[1]))
  }
  return `${core(next)}-beta.${n + 1}`
}

/**
 * Files that never change the app users install: docs, tests, CI and tooling. A change to
 * anything else (app code, skills, mods, package files) is worth a release.
 * ponytail: a fixed list; a new non-app folder must be added here (or it releases once, harmlessly).
 */
export function isAppFile(path) {
  const p = path.trim().replace(/^\.\//, '')
  if (!p) return false
  if (p.endsWith('.md')) return false
  if (/\.test\.tsx?$/.test(p)) return false
  const ignored = ['docs/', '.github/', '.claude/', 'skills/master/tests/', 'app/web/']
  if (ignored.some((d) => p.startsWith(d))) return false
  if (['install.sh', 'LICENSE', '.gitignore'].includes(p)) return false
  return true
}

/** True when any of `files` changes the app. */
export function appChanged(files) {
  return files.some(isAppFile)
}

/**
 * The update's notes (Markdown without HTML: the app draws it with HTML off), one line per merged
 * PR, oldest first. A commit pushed without a PR shows its subject.
 * @param {{version: string, entries: Array<{sha: string, subject: string, pr?: {number: number,
 *   title: string, url: string, issues?: Array<{number: number, url: string}>}}>}} o
 */
export function releaseNotes({ version, entries }) {
  const lines = []
  const seen = new Set()
  for (const e of entries) {
    if (e.pr) {
      if (seen.has(e.pr.number)) continue
      seen.add(e.pr.number)
      const issues = (e.pr.issues ?? []).map((i) => `[#${i.number}](${i.url})`)
      const fixes = issues.length ? `, for ${issues.join(', ')}` : ''
      lines.push(`- ${oneLine(e.pr.title)} ([#${e.pr.number}](${e.pr.url})${fixes})`)
    } else {
      lines.push(`- ${oneLine(e.subject)} (${e.sha.slice(0, 7)})`)
    }
  }
  if (!lines.length) lines.push('- Small fixes.')
  return `## What's new in ${version}\n\n${lines.join('\n')}\n`
}

// A PR title or commit subject on one list line.
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim()

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
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
  const [cmd, ...rest] = process.argv.slice(2)
  const o = args(rest)
  if (cmd === 'next') {
    if (!o.pkg) throw new Error('--pkg is required')
    const tags = readStdin().split('\n').filter(Boolean)
    console.log(nextVersion({ tags, pkgVersion: o.pkg, channel: o.channel || 'stable' }))
  } else if (cmd === 'latest') {
    console.log(releaseTags(readStdin().split('\n'))[0] ?? '')
  } else if (cmd === 'changed') {
    console.log(appChanged(readStdin().split('\n')) ? 'yes' : 'no')
  } else if (cmd === 'notes') {
    if (!o.version || !o.entries) throw new Error('--version and --entries are required')
    process.stdout.write(releaseNotes({ version: o.version, entries: JSON.parse(readFileSync(o.entries, 'utf8')) }))
  } else {
    throw new Error('usage: auto-release.mjs next|latest|changed|notes …')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (e) {
    console.error(`auto-release: ${e.message}`)
    process.exit(1)
  }
}
