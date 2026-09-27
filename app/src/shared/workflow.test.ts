import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hookOwner, parseSteps, stageOf, stepCommand, type CustomStep } from './workflow'

const step = (p: Partial<CustomStep>): CustomStep => ({ id: 'deploy-ab12', trigger: 'pr-created', kind: 'skill', skill: 'my-deploy', mode: 'background', instructions: "Use the 'staging' env.", ...p })

describe.skipIf(process.platform === 'win32')('custom step hooks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wf-'))
  const run = (s: CustomStep, input: object) =>
    execFileSync('bash', ['-c', stepCommand(s)], { cwd: tmp, input: JSON.stringify(input), env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' })

  it('PR created: only a gh pr create that succeeded, once per session and commit', () => {
    const s = step({})
    const ok = { session_id: 'a', tool_input: { command: 'cd x && gh pr create --fill' }, tool_response: { stdout: 'https://github.com/o/r/pull/7' } }
    expect(run(s, { ...ok, tool_response: { stdout: 'error: no commits' } })).toBe('')
    expect(run(s, { ...ok, tool_input: { command: 'echo "then gh pr create"' } })).toBe('')
    // Text written to a file that looks like a command: not run.
    expect(run(s, { ...ok, tool_input: { command: "cat > t.ts <<'EOF'\nconst c = 'cd x && gh pr create --fill'\nEOF" } })).toBe('')
    const out = JSON.parse(run(s, ok))
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(out.hookSpecificOutput.additionalContext).toContain('Use the my-deploy skill')
    expect(out.hookSpecificOutput.additionalContext).toContain("Use the 'staging' env.")
    expect(out.hookSpecificOutput.additionalContext).toContain('run in the background')
    expect(run(s, ok)).toBe('')
    expect(run(s, { ...ok, session_id: 'b' })).not.toBe('')
  }, 20_000) // real bash, awk and jq processes: slow when the whole suite runs at once
  it('session start: once per session, in the session', () => {
    const s = step({ id: 'hello-1', trigger: 'session-start', mode: 'session', instructions: '' })
    const out = JSON.parse(run(s, { session_id: 'c', source: 'startup' }))
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toMatch(/now use the my-deploy skill/)
    expect(run(s, { session_id: 'c' })).toBe('')
  }, 20_000)
})

describe.skipIf(process.platform === 'win32')('instruction steps', () => {
  it('hand the session the text itself, once per session and commit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wfi-'))
    const s = step({ id: 'note-1', trigger: 'after-push', kind: 'instruction', skill: '', mode: 'session', instructions: "After pushing, post the branch's preview URL in the PR." })
    const input = { session_id: 'i1', tool_input: { command: 'git push -u origin feat/x' }, tool_response: { stdout: '' } }
    const run = () => execFileSync('bash', ['-c', stepCommand(s)], { cwd: tmp, input: JSON.stringify(input), env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' })
    const out = JSON.parse(run())
    expect(out.hookSpecificOutput.additionalContext).toBe("Workflow instruction (After a git push): After pushing, post the branch's preview URL in the PR.")
    expect(run()).toBe('')
  }, 20_000)
})

describe('workflow model', () => {
  it('reads instruction steps, and old steps without a kind as skills', () => {
    const got = parseSteps({ steps: [
      { id: 'n-1', trigger: 'pr-merged', kind: 'instruction', instructions: 'Delete the preview app.' },
      { id: 'n-2', trigger: 'pr-merged', kind: 'instruction', instructions: '   ' },
      { id: 'old-1', trigger: 'pr-created', skill: 'x', mode: 'background', instructions: '' },
    ] })
    expect(got.map((x) => [x.id, x.kind, x.skill, x.mode])).toEqual([['n-1', 'instruction', '', 'session'], ['old-1', 'skill', 'x', 'background']])
  })
  it('reads steps defensively', () => {
    expect(parseSteps({ steps: [step({}), { id: 'BAD ID', trigger: 'pr-created', skill: 'x' }, { id: 'ok-1', trigger: 'nope', skill: 'x' }] })).toEqual([step({})])
  })
  it('names MasterDeck hooks and places hooks on the stages', () => {
    expect(hookOwner('"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook')).toBe('babysit-ticket')
    expect(hookOwner(stepCommand(step({})))).toBe('custom step deploy-ab12')
    expect(stageOf({ event: 'SessionStart', command: 'node x.js' })).toBe('session')
    expect(stageOf({ event: 'Stop', command: 'q' })).toBe('instructions')
    expect(stageOf({ event: 'PostToolUse', command: stepCommand(step({ trigger: 'pr-merged' })) }, [step({ trigger: 'pr-merged' })])).toBe('merged')
    expect(stageOf({ event: 'PreToolUse', command: "case $cmd in *'gh pr create'*)" })).toBe('before-pr')
  })
})
