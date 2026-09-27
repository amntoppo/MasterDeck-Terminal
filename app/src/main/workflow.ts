import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { hookOwner, parseSteps, type CustomStep, type HookEntry } from '@shared/workflow'

/**
 * What the Workflow view shows: every hook Claude Code runs (user settings, the workspace's
 * repos' project settings, enabled plugins), the skills that can be attached to a stage, and the
 * custom steps.
 */

type HookBlock = Record<string, { matcher?: string; hooks?: { type?: string; command?: string }[] }[]>

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function entries(block: unknown, source: HookEntry['source'], where: string | null): HookEntry[] {
  const out: HookEntry[] = []
  if (!block || typeof block !== 'object') return out
  for (const [event, list] of Object.entries(block as HookBlock)) {
    if (!Array.isArray(list)) continue
    for (const m of list)
      for (const h of m?.hooks ?? [])
        if (typeof h?.command === 'string') out.push({ source, where, event, matcher: m.matcher ?? null, command: h.command, owner: hookOwner(h.command) })
  }
  return out
}

/** Hooks from ~/.claude/settings.json, the repos' .claude/settings(.local).json, and enabled plugins. */
export function collectHooks(claudeDir: string, repos: string[]): HookEntry[] {
  const out: HookEntry[] = []
  const settings = readJson(join(claudeDir, 'settings.json'))
  out.push(...entries(settings?.hooks, 'user', null))
  const line = (settings?.statusLine as { command?: unknown } | undefined)?.command
  if (typeof line === 'string') out.push({ source: 'user', where: null, event: 'StatusLine', matcher: null, command: line, owner: hookOwner(line) ?? 'status line' })

  // The workspace is often one of the repos too: each folder once.
  for (const repo of [...new Set(repos.map((r) => resolve(r)))])
    for (const f of ['settings.json', 'settings.local.json']) out.push(...entries(readJson(join(repo, '.claude', f))?.hooks, 'project', basename(repo)))

  // Plugins: the enabled ones, where installed_plugins.json says they are.
  const enabled = Object.entries((settings?.enabledPlugins as Record<string, unknown>) ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  const installed = (readJson(join(claudeDir, 'plugins', 'installed_plugins.json'))?.plugins ?? {}) as Record<string, unknown>
  for (const id of enabled) {
    const rec = installed[id]
    const path = (Array.isArray(rec) ? rec[0] : rec) as { installPath?: string } | undefined
    if (!path?.installPath) continue
    const name = id.split('@')[0]
    const manifest = readJson(join(path.installPath, '.claude-plugin', 'plugin.json'))
    const file = readJson(join(path.installPath, 'hooks', 'hooks.json'))
    const block = manifest?.hooks && typeof manifest.hooks === 'object' ? manifest.hooks : file ? (file.hooks ?? file) : null
    out.push(...entries(block, 'plugin', name))
  }
  return out
}

export interface SkillChoice {
  name: string
  description: string
}

/** Skills in ~/.claude/skills that can be attached to a stage: every folder with a SKILL.md. */
export function listSkills(skillsDir: string): SkillChoice[] {
  let dirs: string[] = []
  try {
    dirs = readdirSync(skillsDir).filter((d) => !d.startsWith('.'))
  } catch {
    return []
  }
  const out: SkillChoice[] = []
  for (const d of dirs.sort()) {
    const f = join(skillsDir, d, 'SKILL.md')
    if (!existsSync(f)) continue
    const text = readFileSync(f, 'utf8').slice(0, 4000)
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() || d
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
    out.push({ name, description: description.slice(0, 240) })
  }
  return out
}

export function readSteps(file: string): CustomStep[] {
  try {
    return parseSteps(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

export function writeSteps(file: string, steps: CustomStep[]): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify({ steps }, null, 2) + '\n')
  renameSync(`${file}.tmp`, file)
}
