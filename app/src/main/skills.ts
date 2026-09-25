import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { SkillStatus } from '@shared/types'

/**
 * The Claude Code skills MasterDeck ships (master, babysit-ticket, babysit-pr, ...). They are
 * copied into ~/.claude/skills on launch when missing, and kept up to date while the user hasn't
 * changed them. A skill the user edited, or one that is a symlink, is never overwritten; Settings
 * offers to replace it (the old copy is moved to ~/.claude/skills/.masterdeck-backup first).
 */

const MARKER = '.masterdeck-skill.json'
const SKIP = new Set(['__pycache__', '.pytest_cache', 'tests', MARKER, '.DS_Store'])
const EXECUTABLE = /(\.sh|\/ghc|\/master)$/

interface Marker {
  version: string
  hash: string
}

function files(dir: string, root = dir): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...files(p, root))
    else out.push(relative(root, p))
  }
  return out
}

/** Content hash of a skill folder (paths and bytes), ignoring caches, tests and the marker. */
export function hashSkill(dir: string): string {
  const h = createHash('sha256')
  for (const f of files(dir)) {
    h.update(f.replaceAll('\\', '/'))
    h.update('\0')
    h.update(readFileSync(join(dir, f)))
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

function readMarker(dir: string): Marker | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'))
    return typeof m?.hash === 'string' ? (m as Marker) : null
  } catch {
    return null
  }
}

function copySkill(src: string, dest: string, version: string): void {
  cpSync(src, dest, { recursive: true, filter: (p) => !SKIP.has(basename(p)) })
  for (const f of files(dest)) {
    const p = join(dest, f)
    if (EXECUTABLE.test(p.replaceAll('\\', '/'))) {
      try {
        chmodSync(p, 0o755)
      } catch {
        // Windows: no exec bit
      }
    }
  }
  writeFileSync(join(dest, MARKER), JSON.stringify({ version, hash: hashSkill(src) } satisfies Marker, null, 2))
}

export function bundledSkillNames(bundled: string): string[] {
  try {
    return readdirSync(bundled)
      .filter((n) => !n.startsWith('.') && existsSync(join(bundled, n, 'SKILL.md')))
      .sort()
  } catch {
    return []
  }
}

export function skillStatus(bundled: string, target: string, name: string): SkillStatus {
  const dest = join(target, name)
  const src = join(bundled, name)
  if (!existsSync(dest)) return { name, state: 'missing' }
  if (lstatSync(dest).isSymbolicLink()) return { name, state: 'linked' }
  const m = readMarker(dest)
  if (!m) return { name, state: 'custom' }
  const want = hashSkill(src)
  if (m.hash === want) return { name, state: 'installed', version: m.version }
  // Our copy, unchanged since we installed it: safe to update. Changed by the user: ask first.
  return { name, state: hashSkill(dest) === m.hash ? 'outdated' : 'modified', version: m.version }
}

/**
 * On launch: install missing skills and update unmodified ones. Returns the status of each and
 * any errors (which never stop the app).
 */
export function syncSkills(bundled: string, target: string, version: string): { skills: SkillStatus[]; errors: string[] } {
  const errors: string[] = []
  const skills: SkillStatus[] = []
  for (const name of bundledSkillNames(bundled)) {
    let st = skillStatus(bundled, target, name)
    try {
      if (st.state === 'missing' || st.state === 'outdated') {
        mkdirSync(target, { recursive: true })
        const dest = join(target, name)
        if (st.state === 'outdated') renameSync(dest, backupPath(target, name))
        copySkill(join(bundled, name), dest, version)
        st = skillStatus(bundled, target, name)
      }
    } catch (e) {
      errors.push(`could not install the ${name} skill: ${String(e)}`)
    }
    skills.push(st)
  }
  return { skills, errors }
}

function backupPath(target: string, name: string): string {
  const dir = join(target, '.masterdeck-backup')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
}

/** Replace an installed skill with the bundled copy; the old folder (or link) is kept as a backup. */
export function reinstallSkill(bundled: string, target: string, name: string, version: string): { ok: boolean; message: string } {
  if (!bundledSkillNames(bundled).includes(name)) return { ok: false, message: `no bundled skill named ${name}` }
  const dest = join(target, name)
  try {
    let backup = ''
    if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
      backup = backupPath(target, name)
      renameSync(dest, backup)
    }
    copySkill(join(bundled, name), dest, version)
    return { ok: true, message: backup ? `reinstalled; the old copy is in ${backup}` : 'installed' }
  } catch (e) {
    return { ok: false, message: `could not reinstall ${name}: ${String(e)}` }
  }
}
