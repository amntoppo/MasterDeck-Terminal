import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hookStatus, installHooks } from './hooks'

describe.skipIf(process.platform === 'win32')('hooks', () => {
  it('adds, keeps other settings, is idempotent, and removes', () => {
    const d = mkdtempSync(join(tmpdir(), 'hooks-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({ model: 'x', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }))
    expect(hookStatus(p)).toEqual({ ticket: false, pr: false, queue: false, proof: false })
    expect(installHooks(p, d, { ticket: true, pr: true, queue: true, proof: true }).ok).toBe(true)
    installHooks(p, d, { ticket: true, pr: true, queue: true, proof: true })
    const s = JSON.parse(readFileSync(p, 'utf8'))
    expect(s.model).toBe('x')
    expect(hookStatus(p)).toEqual({ ticket: true, pr: true, queue: true, proof: true })
    const cmds = JSON.stringify(s.hooks)
    expect(cmds.split('babysit-ticket/scripts/tt.sh').length - 1).toBe(2)
    expect(cmds).toContain('other')
    installHooks(p, d, { ticket: false, pr: true, queue: false, proof: false })
    expect(hookStatus(p)).toEqual({ ticket: false, pr: true, queue: false, proof: false })
    expect(readFileSync(p, 'utf8')).toContain('other')
    expect(readFileSync(p, 'utf8')).not.toContain('queue-')
  })
  it('babysit-proof: a note once per session and commit, only for gh pr create', () => {
    const d = mkdtempSync(join(tmpdir(), 'hooks-'))
    const p = join(d, 'settings.json')
    installHooks(p, d, { ticket: false, pr: false, queue: false, proof: true })
    const s = JSON.parse(readFileSync(p, 'utf8'))
    const cmd = s.hooks.PreToolUse.flatMap((m: { hooks: { command: string }[] }) => m.hooks).find((h: { command: string }) => h.command.includes('babysit-proof skill')).command
    const repo = mkdtempSync(join(tmpdir(), 'repo-'))
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a])
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'one')
    const run = (command: string, sid = 's1') =>
      execFileSync('bash', ['-c', cmd], { cwd: repo, input: JSON.stringify({ session_id: sid, tool_input: { command } }), env: { ...process.env, TMPDIR: d }, encoding: 'utf8' })
    expect(run('git status')).toBe('')
    // Mentioned, not run: text written to a file, or a sentence.
    expect(run("cat > notes.md <<'EOF'\nThen `gh pr create` opens the PR.\nEOF")).toBe('')
    expect(run("cat > t.ts <<'EOF'\nconst c = 'cd x && gh pr create --fill'\nEOF")).toBe('')
    expect(run('echo "run gh pr create later"')).toBe('')
    const out = JSON.parse(run('cd sub && gh pr create --fill'))
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.additionalContext).toContain('Agent tool')
    expect(out.hookSpecificOutput.additionalContext).toContain('do not wait for it')
    expect(run('gh pr create --fill')).toBe('') // the retry after babysit-pr's soft gate
    expect(run('gh pr create --fill', 's2')).not.toBe('') // another session
    git('commit', '-q', '--allow-empty', '-m', 'two')
    expect(run('gh pr create --fill')).not.toBe('') // a new commit
  }, 20_000) // real git and bash processes: slow when the whole suite runs at once
  it('counts a queue install from ~/.claude/hooks and never doubles it', () => {
    const d = mkdtempSync(join(tmpdir(), 'hooks-'))
    const p = join(d, 'settings.json')
    const old = (f: string) => ({ hooks: [{ type: 'command', command: `$HOME/.claude/hooks/${f}`, timeout: 10 }] })
    writeFileSync(p, JSON.stringify({ hooks: { UserPromptSubmit: [old('queue-submit.sh')], Stop: [old('queue-drain.sh')] } }))
    expect(hookStatus(p).queue).toBe(true)
    installHooks(p, d, { ticket: false, pr: false, queue: true, proof: true })
    expect(readFileSync(p, 'utf8').split('queue-submit.sh').length - 1).toBe(1)
  })
})
