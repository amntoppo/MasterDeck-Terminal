import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guardedBuiltin } from '@shared/flow'
import { hookStatus, installDeckHooks, installReviewGate, installWorkflowHooks, LEGACY_COMMANDS, migrateLegacyHooks, reviewGateCommand } from './hooks'

const TT = '"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook'
const entry = (command: string, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] })

describe.skipIf(process.platform === 'win32')('migrateLegacyHooks', () => {
  it("removes exactly what MasterDeck installed for the skills and keeps the user's own", () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({
      model: 'x',
      hooks: {
        PostToolUse: [entry(guardedBuiltin('ticket', TT, d), 'Bash'), entry(guardedBuiltin('pr-watch', LEGACY_COMMANDS.prPost, d), 'Bash'), entry('my-own.sh', 'Bash')],
        SessionStart: [entry(TT)],
        UserPromptSubmit: [entry('"$HOME/.claude/skills/queue/scripts/queue-submit.sh"'), entry('$HOME/.claude/hooks/queue-submit.sh')],
        Stop: [entry('"$HOME/.claude/skills/queue/scripts/queue-drain.sh"')],
      },
    }))
    const r = migrateLegacyHooks(p, d)
    expect(r.removed.sort()).toEqual(['pr (PostToolUse)', 'queue (Stop)', 'queue (UserPromptSubmit)', 'ticket (PostToolUse)', 'ticket (SessionStart)'])
    const s = JSON.parse(readFileSync(p, 'utf8'))
    expect(s.model).toBe('x')
    expect(JSON.stringify(s.hooks)).toContain('my-own.sh')
    expect(JSON.stringify(s.hooks)).toContain('$HOME/.claude/hooks/queue-submit.sh')
    expect(JSON.stringify(s.hooks)).not.toContain('babysit-ticket')
    expect(s.hooks.Stop).toBeUndefined()
    expect(readdirSync(d).some((n) => n.startsWith('settings.backup.'))).toBe(true)
    // The hand-installed queue hook left behind switches MasterDeck's queue off.
    expect(hookStatus(p).foreignQueue).toBe(true)
  })
  it('keeps a hand-edited tt.sh call and an unrelated masterdeck-builtin wrapper', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'))
    const p = join(d, 'settings.json')
    const mine = '"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook --verbose'
    writeFileSync(p, JSON.stringify({ hooks: { SessionStart: [entry(mine), entry(guardedBuiltin('ticket', 'my-board.sh', d))] } }))
    expect(migrateLegacyHooks(p, d)).toEqual({ removed: [] })
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.SessionStart).toHaveLength(2)
  })
  it('is a no-op on a clean file (no write, no backup)', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, '{"hooks":{}}')
    expect(migrateLegacyHooks(p, d)).toEqual({ removed: [] })
    expect(readdirSync(d)).toEqual(['settings.json'])
  })
})

describe.skipIf(process.platform === 'win32')('hookStatus', () => {
  it('sees queue hooks installed by hand', () => {
    const d = mkdtempSync(join(tmpdir(), 'hs-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({ hooks: { UserPromptSubmit: [entry('$HOME/.claude/hooks/queue-submit.sh')], Stop: [entry('$HOME/.claude/hooks/queue-drain.sh')] } }))
    expect(hookStatus(p)).toEqual({ queue: true, foreignQueue: true, reviewGate: false, masterGuard: false })
    expect(hookStatus(join(d, 'missing.json'))).toEqual({ queue: false, foreignQueue: false, reviewGate: false, masterGuard: false })
  })
  it("MasterDeck's hook runs /queue unless a half-installed skill hook switched it off", () => {
    const d = mkdtempSync(join(tmpdir(), 'hs-'))
    const p = join(d, 'settings.json')
    installDeckHooks(p, d, join(d, 'deck/hook.sh'))
    expect(hookStatus(p)).toEqual({ queue: true, foreignQueue: false, reviewGate: false, masterGuard: true })
    const s = JSON.parse(readFileSync(p, 'utf8'))
    s.hooks.Stop.push(entry('$HOME/.claude/hooks/queue-drain.sh'))
    writeFileSync(p, JSON.stringify(s))
    expect(hookStatus(p)).toEqual({ queue: false, foreignQueue: true, reviewGate: false, masterGuard: true })
  })
})

describe.skipIf(process.platform === 'win32')('master reports guard', () => {
  it('is reported by hookStatus and left alone by the migration and the review gate', () => {
    const d = mkdtempSync(join(tmpdir(), 'mg-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [entry(guardedBuiltin('pr-review', LEGACY_COMMANDS.prPre, d), 'Bash')] } }))
    expect(hookStatus(p).masterGuard).toBe(false)
    installDeckHooks(p, d, join(d, 'deck/hook.sh'))
    installReviewGate(p, d, d, true)
    expect(migrateLegacyHooks(p, d).removed).toEqual(['pr (PreToolUse)'])
    expect(hookStatus(p)).toEqual({ queue: true, foreignQueue: false, reviewGate: true, masterGuard: true })
    installReviewGate(p, d, d, false)
    expect(hookStatus(p)).toEqual({ queue: true, foreignQueue: false, reviewGate: false, masterGuard: true })
    const pre = JSON.parse(readFileSync(p, 'utf8')).hooks.PreToolUse as { matcher?: string }[]
    expect(pre.map((m) => m.matcher).sort()).toEqual(['Monitor', 'SendMessage'])
  })
})

describe.skipIf(process.platform === 'win32')('migrateLegacyHooks, shared matcher', () => {
  it("removes MasterDeck's command and keeps the user's in one matcher", () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: TT }, { type: 'command', command: 'mine.sh' }] }] } }))
    expect(migrateLegacyHooks(p, d).removed).toEqual(['ticket (SessionStart)'])
    const s = JSON.parse(readFileSync(p, 'utf8'))
    expect(s.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'mine.sh' }] }])
  })
})

describe.skipIf(process.platform === 'win32')('review gate', () => {
  const SID = '66666666-6666-4666-8666-666666666666'
  const gate = (home: string, cwd: string, command: string) =>
    execFileSync('bash', ['-c', reviewGateCommand(home)], { cwd, input: JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command } }), env: { ...process.env, TMPDIR: home } }).toString()
  const repoIn = (home: string) => {
    const repo = join(home, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x'])
    return repo
  }
  it('denies the first gh pr create per session, then lets it through', () => {
    const home = mkdtempSync(join(tmpdir(), 'rg-'))
    const repo = repoIn(home)
    expect(gate(home, repo, 'echo "gh pr create later" > notes.txt')).toBe('')
    const first = JSON.parse(gate(home, repo, 'git push && gh pr create --fill'))
    expect(first.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(first.hookSpecificOutput.permissionDecisionReason).toMatch(/review your diff against the base branch/)
    expect(gate(home, repo, 'gh pr create --fill')).toBe('')
  }, 20_000)
  it('denies once per branch: same branch passes, a new branch is denied once', () => {
    const home = mkdtempSync(join(tmpdir(), 'rg-'))
    const repo = repoIn(home)
    expect(gate(home, repo, 'gh pr create')).not.toBe('')
    expect(gate(home, repo, 'gh pr create')).toBe('')
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/two'])
    expect(gate(home, repo, 'gh pr create')).not.toBe('')
    expect(gate(home, repo, 'gh pr create')).toBe('')
    expect(gate(home, repo, 'ls -la')).toBe('')
  }, 20_000)
  it('migration leaves an installed gate alone', () => {
    const d = mkdtempSync(join(tmpdir(), 'rg-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, '{}')
    installReviewGate(p, d, d, true)
    expect(migrateLegacyHooks(p, d)).toEqual({ removed: [] })
    expect(hookStatus(p).reviewGate).toBe(true)
  })
  it('lets it through when a hand-run babysit-pr wrote the marker for HEAD', () => {
    const home = mkdtempSync(join(tmpdir(), 'rg-'))
    const repo = repoIn(home)
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim()
    writeFileSync(join(repo, '.git', `pr-selfreview-${sha}`), '')
    expect(gate(home, repo, 'gh pr create --fill')).toBe('')
  }, 20_000)
  it('skips sessions whose workflow left pr-review out', () => {
    const home = mkdtempSync(join(tmpdir(), 'rg-'))
    mkdirSync(join(home, 'workflows', 'sessions'), { recursive: true })
    writeFileSync(join(home, 'workflows', 'sessions', `${SID}.json`), JSON.stringify({ builtins: ['ticket'] }))
    expect(gate(home, home, 'gh pr create')).toBe('')
  })
  it('installs once, and removes', () => {
    const d = mkdtempSync(join(tmpdir(), 'rg-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, '{}')
    installReviewGate(p, d, d, true)
    installReviewGate(p, d, d, true)
    expect(readFileSync(p, 'utf8').split('masterdeck-review-gate').length - 1).toBe(1)
    expect(hookStatus(p).reviewGate).toBe(true)
    installReviewGate(p, d, d, false)
    expect(hookStatus(p).reviewGate).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('installWorkflowHooks', () => {
  it('rewrites hooks from an older MasterDeck once, then leaves settings.json alone', () => {
    const d = mkdtempSync(join(tmpdir(), 'wfh-'))
    const p = join(d, 'settings.json')
    const backups = join(d, 'backups')
    writeFileSync(p, JSON.stringify({ model: 'x' }))
    installWorkflowHooks(p, backups, d, true)
    // An older trigger hook (here: one without the loop arming) is found by its mark and replaced.
    const s = JSON.parse(readFileSync(p, 'utf8'))
    s.hooks.PostToolUse[0].hooks[0].command = 'true # masterdeck-workflow:trigger-after-push'
    writeFileSync(p, JSON.stringify(s))
    const count = () => readdirSync(backups).length
    const before = count()
    installWorkflowHooks(p, backups, d, true)
    expect(count()).toBe(before + 1)
    const text = readFileSync(p, 'utf8')
    expect(text).toContain(`grep -q '\\"loops\\"'`)
    installWorkflowHooks(p, backups, d, true)
    expect(count()).toBe(before + 1)
    expect(readFileSync(p, 'utf8')).toBe(text)
    expect(JSON.parse(text).model).toBe('x')
  })
})
