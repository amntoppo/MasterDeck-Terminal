import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CliResult, HookStatus } from '@shared/types'

/**
 * Claude Code hooks the bundled skills rely on, installed into ~/.claude/settings.json:
 * - babysit-ticket: `tt.sh hook` after each Bash call and at session start (moves the board).
 * - babysit-pr: a soft gate before `gh pr create` (self-review first) and a reminder after it
 *   (start babysitting the PR).
 * Installing is idempotent and keeps everything else in the file; a backup is written first.
 */

type Hook = { type: 'command'; command: string }
type Matcher = { matcher?: string; hooks: Hook[] }
type Settings = Record<string, unknown> & { hooks?: Record<string, Matcher[]> }

const TT = '"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook'
const TT_MARK = 'babysit-ticket/scripts/tt.sh'

const PR_PRE =
  `cmd=$(jq -r '.tool_input.command // ""'); case "$cmd" in *'gh pr create'*) sha=$(git rev-parse HEAD 2>/dev/null) || exit 0; ` +
  `[ -f ".git/pr-selfreview-$sha" ] && exit 0; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Soft gate: no self-review marker for current HEAD. ` +
  `Before creating this PR, run the pre-PR self-review from the babysit-pr skill (review branch diff, fix findings, commit, write marker .git/pr-selfreview-<HEAD sha>). ` +
  `Proceed without it only if the user explicitly said to skip review."}}' ;; esac`
const PR_POST =
  `cmd=$(jq -r '.tool_input.command // ""'); case "$cmd" in *'gh pr create'*) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"PR created. ` +
  `Arm the Monitor now (timeout_ms 1800000; re-arm on each expiry, there is no persistent flag), per the Monitor phase of the babysit-pr skill: ` +
  `it emits an event per new review comment; on each wake fix and push, reply, resolve threads; the watch ends when the PR is merged/closed."}}' ;; esac`
const PR_MARK = 'pr-selfreview-'
const PR_POST_MARK = 'Monitor phase of the babysit-pr skill'

function read(path: string): Settings {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Settings
}

function has(s: Settings, event: string, mark: string): boolean {
  return (s.hooks?.[event] ?? []).some((m) => (m.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(mark)))
}

function add(s: Settings, event: string, matcher: string | undefined, command: string, mark: string): void {
  if (has(s, event, mark)) return
  s.hooks ??= {}
  const list = (s.hooks[event] ??= [])
  list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] })
}

function remove(s: Settings, event: string, mark: string): void {
  const list = s.hooks?.[event]
  if (!list) return
  const kept = list
    .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !(typeof h.command === 'string' && h.command.includes(mark))) }))
    .filter((m) => m.hooks.length > 0)
  if (kept.length) s.hooks![event] = kept
  else delete s.hooks![event]
}

export function hookStatus(settingsPath: string): HookStatus {
  try {
    const s = read(settingsPath)
    return {
      ticket: has(s, 'PostToolUse', TT_MARK) && has(s, 'SessionStart', TT_MARK),
      pr: has(s, 'PreToolUse', PR_MARK) && has(s, 'PostToolUse', PR_POST_MARK),
    }
  } catch {
    return { ticket: false, pr: false }
  }
}

function write(settingsPath: string, backupDir: string, s: Settings): void {
  if (existsSync(settingsPath)) {
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(settingsPath, join(backupDir, `settings.backup.${Date.now()}.json`))
  }
  // Follow a symlink so a dotfiles link stays a link.
  const target = existsSync(settingsPath) ? realpathSync(settingsPath) : settingsPath
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.masterdeck-tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  renameSync(tmp, target)
}

export function installHooks(settingsPath: string, backupDir: string, which: { ticket: boolean; pr: boolean }): CliResult {
  if (process.platform === 'win32') return { ok: false, message: 'these hooks are bash scripts; on Windows add them by hand under Git Bash (see README)' }
  try {
    const s = read(settingsPath)
    if (which.ticket) {
      add(s, 'PostToolUse', 'Bash', TT, TT_MARK)
      add(s, 'SessionStart', undefined, TT, TT_MARK)
    } else {
      remove(s, 'PostToolUse', TT_MARK)
      remove(s, 'SessionStart', TT_MARK)
    }
    if (which.pr) {
      add(s, 'PreToolUse', 'Bash', PR_PRE, PR_MARK)
      add(s, 'PostToolUse', 'Bash', PR_POST, PR_POST_MARK)
    } else {
      remove(s, 'PreToolUse', PR_MARK)
      remove(s, 'PostToolUse', PR_POST_MARK)
    }
    write(settingsPath, backupDir, s)
    return { ok: true, message: 'hooks saved' }
  } catch (e) {
    return { ok: false, message: `could not update ${settingsPath}: ${String(e)}` }
  }
}
